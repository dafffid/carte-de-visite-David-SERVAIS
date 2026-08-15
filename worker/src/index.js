/**
 * Statistiques de la carte de visite Symbotis.
 *
 *   POST /collect      dépôt d'un événement par la carte (CORS restreint)
 *   GET  /stats        tableau de bord privé (mot de passe)
 *   POST /connexion    vérification du mot de passe, pose du cookie signé
 *   GET  /deconnexion  purge du cookie
 *
 * Vie privée : aucun cookie n'est posé chez les visiteurs de la carte. Le seul
 * cookie du service est celui de session de l'administrateur sur /stats.
 */

const MARINE = "#1F2A63";
const ORANGE = "#F39448";
const DUREE_SESSION = 7 * 24 * 3600; // secondes
const TAILLE_MAX_CORPS = 512; // octets acceptés sur /collect
const RETENTION_JOURS = 400; // purge opportuniste au-delà

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const chemin = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (chemin === "/collect") {
        if (request.method === "OPTIONS") return preflight(request, env);
        if (request.method === "POST") return collecter(request, env, ctx);
        return texte("Méthode non autorisée", 405);
      }
      if (chemin === "/" || chemin === "/stats") return pageStats(request, env);
      if (chemin === "/connexion" && request.method === "POST") return connexion(request, env);
      if (chemin === "/deconnexion") return deconnexion();
      return texte("Introuvable", 404);
    } catch (e) {
      // On ne renvoie jamais le détail interne au client.
      console.error("erreur worker:", e && e.stack ? e.stack : String(e));
      return texte("Erreur interne", 500);
    }
  },
};

/* ============================================================
   COLLECTE
   ============================================================ */

function origineOk(request, env) {
  return (request.headers.get("Origin") || "") === env.ORIGINE_AUTORISEE;
}

function enTetesCors(env) {
  return {
    "Access-Control-Allow-Origin": env.ORIGINE_AUTORISEE,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function preflight(request, env) {
  if (!origineOk(request, env)) return texte("Origine refusée", 403);
  return new Response(null, { status: 204, headers: enTetesCors(env) });
}

/** Ne laisse passer que des identifiants sobres : a-z, 0-9 et tirets. */
function nettoyer(valeur, longueurMax) {
  if (typeof valeur !== "string") return "";
  return valeur.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, longueurMax);
}

/**
 * Empreinte visiteur anonyme : SHA-256(sel secret | jour | IP | user-agent),
 * tronquée à 16 caractères hexadécimaux. Irréversible, et comme le jour entre
 * dans le hash, deux visites à deux dates ne sont pas rattachables entre elles.
 */
async function empreinteVisiteur(request, env, jour) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  const source = `${env.SEL_EMPREINTE}|${jour}|${ip}|${ua}`;
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(buffer)]
    .slice(0, 8)
    .map((o) => o.toString(16).padStart(2, "0"))
    .join("");
}

async function collecter(request, env, ctx) {
  if (!origineOk(request, env)) return texte("Origine refusée", 403);

  let charge;
  try {
    const brut = await request.text();
    if (brut.length > TAILLE_MAX_CORPS) return texte("Corps trop volumineux", 413);
    charge = JSON.parse(brut);
  } catch {
    return new Response("JSON invalide", { status: 400, headers: enTetesCors(env) });
  }

  const nom = nettoyer(charge && charge.ev, 40);
  if (!nom) return new Response("Événement manquant", { status: 400, headers: enTetesCors(env) });
  const src = nettoyer(charge && charge.src, 20) || "direct";

  const maintenant = new Date();
  const jour = maintenant.toISOString().slice(0, 10);
  const empreinte = await empreinteVisiteur(request, env, jour);
  const pays = (request.headers.get("CF-IPCountry") || "XX").slice(0, 2);

  await env.DB.prepare(
    "INSERT INTO evenement (nom, src, pays, empreinte, jour, horodatage) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(nom, src, pays, empreinte, jour, maintenant.toISOString())
    .run();

  // Purge opportuniste (1 requête sur 200) : garde la base bornée sans
  // consommer de créneau CRON.
  if (Math.random() < 0.005) {
    const limite = new Date(maintenant.getTime() - RETENTION_JOURS * 86400000)
      .toISOString()
      .slice(0, 10);
    ctx.waitUntil(
      env.DB.prepare("DELETE FROM evenement WHERE jour < ?").bind(limite).run().catch(() => {})
    );
  }

  return new Response(null, { status: 204, headers: enTetesCors(env) });
}

/* ============================================================
   AUTHENTIFICATION DU TABLEAU DE BORD
   ============================================================ */

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((o) => o.toString(16).padStart(2, "0")).join("");
}

async function sha256(texteBrut) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texteBrut)));
}

async function signer(valeur, env) {
  const cle = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SECRET_SESSION),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", cle, new TextEncoder().encode(valeur)));
}

/** Comparaison à temps constant : ne fuit pas le nombre de caractères justes. */
function egalConstant(a, b) {
  if (a.length !== b.length) return false;
  let ecart = 0;
  for (let i = 0; i < a.length; i++) ecart |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return ecart === 0;
}

function lireCookie(request, nom) {
  const brut = request.headers.get("Cookie") || "";
  for (const morceau of brut.split(";")) {
    const [cle, ...reste] = morceau.trim().split("=");
    if (cle === nom) return reste.join("=");
  }
  return null;
}

async function sessionValide(request, env) {
  const cookie = lireCookie(request, "session");
  if (!cookie) return false;
  const [expiration, signature] = cookie.split(".");
  if (!expiration || !signature) return false;
  if (Number(expiration) < Math.floor(Date.now() / 1000)) return false;
  return egalConstant(await signer(expiration, env), signature);
}

async function connexion(request, env) {
  const formulaire = await request.formData();
  const propose = String(formulaire.get("motdepasse") || "");

  // On compare des hash de longueur fixe pour que la durée du test ne dépende
  // pas de la longueur du mot de passe saisi.
  const ok = egalConstant(await sha256(propose), await sha256(String(env.MOTDEPASSE || "")));
  if (!ok) {
    // Petite temporisation : rend le bourrinage nettement moins confortable.
    await new Promise((r) => setTimeout(r, 800));
    return new Response(pageConnexion("Mot de passe incorrect."), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const expiration = String(Math.floor(Date.now() / 1000) + DUREE_SESSION);
  const cookie = `session=${expiration}.${await signer(expiration, env)}`;
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/stats",
      "Set-Cookie": `${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${DUREE_SESSION}`,
    },
  });
}

function deconnexion() {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/stats",
      "Set-Cookie": "session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
    },
  });
}

/* ============================================================
   REQUÊTES STATISTIQUES
   ============================================================ */

function jourMoins(nbJours) {
  return new Date(Date.now() - nbJours * 86400000).toISOString().slice(0, 10);
}

async function collecterStats(env, fenetre) {
  const depuis = jourMoins(fenetre);
  const db = env.DB;

  const [totaux, entonnoir, canaux, parJour, evenements, pays] = await Promise.all([
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN nom = 'visite' THEN 1 ELSE 0 END)      AS visites,
           COUNT(DISTINCT empreinte)                            AS visiteurs,
           SUM(CASE WHEN nom LIKE 'clic-rdv%' THEN 1 ELSE 0 END) AS clics_rdv,
           SUM(CASE WHEN nom <> 'visite' THEN 1 ELSE 0 END)     AS interactions
         FROM evenement WHERE jour >= ?`
      )
      .bind(depuis)
      .first(),

    db
      .prepare(
        `SELECT
           COUNT(DISTINCT CASE WHEN nom = 'visite' THEN empreinte END)        AS etape_visite,
           COUNT(DISTINCT CASE WHEN nom <> 'visite' THEN empreinte END)       AS etape_interaction,
           COUNT(DISTINCT CASE WHEN nom LIKE 'clic-rdv%' THEN empreinte END)  AS etape_rdv
         FROM evenement WHERE jour >= ?`
      )
      .bind(depuis)
      .first(),

    db
      .prepare(
        `SELECT src,
                SUM(CASE WHEN nom = 'visite' THEN 1 ELSE 0 END)       AS visites,
                COUNT(DISTINCT empreinte)                             AS visiteurs,
                SUM(CASE WHEN nom LIKE 'clic-rdv%' THEN 1 ELSE 0 END) AS clics_rdv
         FROM evenement WHERE jour >= ?
         GROUP BY src ORDER BY visites DESC, visiteurs DESC`
      )
      .bind(depuis)
      .all(),

    db
      .prepare(
        `SELECT jour,
                SUM(CASE WHEN nom = 'visite' THEN 1 ELSE 0 END)       AS visites,
                SUM(CASE WHEN nom LIKE 'clic-rdv%' THEN 1 ELSE 0 END) AS clics_rdv
         FROM evenement WHERE jour >= ?
         GROUP BY jour ORDER BY jour`
      )
      .bind(depuis)
      .all(),

    db
      .prepare(
        `SELECT nom, COUNT(*) AS total, COUNT(DISTINCT empreinte) AS visiteurs
         FROM evenement WHERE jour >= ? AND nom <> 'visite'
         GROUP BY nom ORDER BY total DESC LIMIT 20`
      )
      .bind(depuis)
      .all(),

    db
      .prepare(
        `SELECT pays, COUNT(DISTINCT empreinte) AS visiteurs
         FROM evenement WHERE jour >= ?
         GROUP BY pays ORDER BY visiteurs DESC LIMIT 8`
      )
      .bind(depuis)
      .all(),
  ]);

  return {
    depuis,
    fenetre,
    totaux: totaux || {},
    entonnoir: entonnoir || {},
    canaux: (canaux && canaux.results) || [],
    parJour: (parJour && parJour.results) || [],
    evenements: (evenements && evenements.results) || [],
    pays: (pays && pays.results) || [],
  };
}

/* ============================================================
   RENDU HTML
   ============================================================ */

function echapper(valeur) {
  return String(valeur == null ? "" : valeur).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

function pourcent(numerateur, denominateur) {
  const n = Number(numerateur) || 0;
  const d = Number(denominateur) || 0;
  if (!d) return "0 %";
  return (Math.round((n / d) * 1000) / 10).toString().replace(".", ",") + " %";
}

const STYLE = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
     background:#F3F5FA;color:#17203F;padding:24px 16px 64px;line-height:1.5}
.page{max-width:960px;margin:0 auto}
header.titre{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between;margin-bottom:6px}
h1{font-size:1.5rem;color:${MARINE}}
h2{font-size:1rem;color:${MARINE};margin:28px 0 12px;padding-bottom:6px;border-bottom:2px solid ${ORANGE};display:inline-block}
.sous{color:#5A6178;font-size:.85rem}
a{color:${MARINE}}
.grille{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:16px}
.tuile{background:#fff;border-radius:14px;padding:16px;box-shadow:0 1px 3px #1F2A630D,0 8px 24px #1F2A6310;border-top:3px solid ${ORANGE}}
.tuile .valeur{font-size:1.8rem;font-weight:700;color:${MARINE};line-height:1.1}
.tuile .label{font-size:.78rem;color:#5A6178;text-transform:uppercase;letter-spacing:.06em;margin-top:4px}
.carte{background:#fff;border-radius:14px;padding:18px;box-shadow:0 1px 3px #1F2A630D,0 8px 24px #1F2A6310;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.9rem;min-width:420px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #E2E6F0}
th{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#5A6178;font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
.etape{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.etape .nom{width:190px;flex-shrink:0;font-size:.86rem}
.etape .barre{flex:1;background:#E2E6F0;border-radius:999px;height:26px;overflow:hidden;min-width:60px}
.etape .barre span{display:block;height:100%;background:linear-gradient(90deg,#2A3A85,${MARINE});
                   color:#fff;font-size:.76rem;font-weight:600;display:flex;align-items:center;
                   padding-left:10px;white-space:nowrap}
.etape .taux{width:74px;text-align:right;font-size:.84rem;color:${ORANGE};font-weight:700;flex-shrink:0}
.vide{color:#5A6178;font-size:.9rem;padding:8px 0}
.pied{margin-top:32px;font-size:.78rem;color:#5A6178;border-top:1px solid #E2E6F0;padding-top:14px}
.btn{display:inline-block;background:${MARINE};color:#fff;text-decoration:none;padding:9px 16px;
     border-radius:9px;font-size:.85rem;font-weight:600;border:none;cursor:pointer}
.onglets{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.onglets a{font-size:.8rem;text-decoration:none;padding:5px 12px;border-radius:999px;
           background:#fff;border:1px solid #E2E6F0;color:#5A6178;cursor:pointer}
.onglets a.actif{background:${MARINE};color:#fff;border-color:${MARINE}}
@media(max-width:560px){.etape .nom{width:110px;font-size:.78rem}.etape .taux{width:58px}}
`;

function enveloppe(titre, contenu) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${echapper(titre)}</title><style>${STYLE}</style></head>
<body><div class="page">${contenu}</div></body></html>`;
}

function pageConnexion(erreur) {
  return enveloppe(
    "Statistiques - connexion",
    `<h1>Statistiques de la carte</h1>
     <p class="sous">Accès réservé.</p>
     <div class="carte" style="max-width:380px;margin-top:20px">
       <form method="post" action="/connexion">
         <label for="mdp" style="font-size:.85rem;display:block;margin-bottom:6px">Mot de passe</label>
         <input id="mdp" type="password" name="motdepasse" autocomplete="current-password" required
                style="width:100%;padding:10px 12px;border:1.5px solid #E2E6F0;border-radius:9px;
                       font-size:.95rem;font-family:inherit">
         ${erreur ? `<p style="color:#C0392B;font-size:.82rem;margin-top:8px">${echapper(erreur)}</p>` : ""}
         <button class="btn" type="submit" style="margin-top:14px;width:100%">Entrer</button>
       </form>
     </div>`
  );
}

/** Histogramme SVG des visites par jour, sans aucune dépendance externe. */
function graphique(parJour, fenetre) {
  const index = new Map(parJour.map((l) => [l.jour, l]));
  const jours = [];
  for (let i = fenetre - 1; i >= 0; i--) {
    const j = jourMoins(i);
    const ligne = index.get(j) || {};
    jours.push({ jour: j, visites: Number(ligne.visites) || 0, rdv: Number(ligne.clics_rdv) || 0 });
  }
  const max = Math.max(1, ...jours.map((j) => j.visites));
  const largeur = 720;
  const hauteur = 150;
  const pas = largeur / jours.length;
  const barres = jours
    .map((j, i) => {
      const h = (j.visites / max) * (hauteur - 24);
      const hr = (j.rdv / max) * (hauteur - 24);
      const x = i * pas + pas * 0.15;
      const l = pas * 0.7;
      return (
        `<rect x="${x.toFixed(1)}" y="${(hauteur - 18 - h).toFixed(1)}" width="${l.toFixed(1)}" height="${h.toFixed(1)}" fill="${MARINE}" rx="1.5"><title>${j.jour} : ${j.visites} visite(s), ${j.rdv} clic(s) RDV</title></rect>` +
        (hr > 0
          ? `<rect x="${x.toFixed(1)}" y="${(hauteur - 18 - hr).toFixed(1)}" width="${l.toFixed(1)}" height="${hr.toFixed(1)}" fill="${ORANGE}" rx="1.5"></rect>`
          : "")
      );
    })
    .join("");
  const etiquettes = jours
    .map((j, i) =>
      i % 5 === 0
        ? `<text x="${(i * pas + pas / 2).toFixed(1)}" y="${hauteur - 4}" font-size="9" fill="#5A6178" text-anchor="middle">${j.jour.slice(8)}/${j.jour.slice(5, 7)}</text>`
        : ""
    )
    .join("");
  return `<svg viewBox="0 0 ${largeur} ${hauteur}" style="width:100%;height:auto;display:block" role="img"
     aria-label="Visites par jour sur ${fenetre} jours">
  <line x1="0" y1="${hauteur - 18}" x2="${largeur}" y2="${hauteur - 18}" stroke="#E2E6F0"/>
  ${barres}${etiquettes}
</svg>
<p class="sous" style="margin-top:8px">
  <span style="display:inline-block;width:10px;height:10px;background:${MARINE};border-radius:2px"></span> visites
  &nbsp;&nbsp;
  <span style="display:inline-block;width:10px;height:10px;background:${ORANGE};border-radius:2px"></span> clics RDV
  &nbsp;&nbsp;· maximum ${max} visite(s) sur une journée
</p>`;
}

function blocEntonnoir(e) {
  const v = Number(e.etape_visite) || 0;
  const i = Number(e.etape_interaction) || 0;
  const r = Number(e.etape_rdv) || 0;
  const max = Math.max(1, v, i, r);
  const etapes = [
    ["Visiteurs de la carte", v, null],
    ["Ont cliqué quelque chose", i, v],
    ["Ont cliqué Prendre RDV", r, v],
  ];
  return etapes
    .map(([nom, valeur, base]) => {
      const largeur = Math.max(valeur > 0 ? 8 : 0, (valeur / max) * 100);
      return `<div class="etape">
        <div class="nom">${echapper(nom)}</div>
        <div class="barre"><span style="width:${largeur.toFixed(1)}%">${valeur}</span></div>
        <div class="taux">${base === null ? "" : pourcent(valeur, base)}</div>
      </div>`;
    })
    .join("");
}

function tableau(entetes, lignes, messageVide) {
  if (!lignes.length) return `<p class="vide">${echapper(messageVide)}</p>`;
  return `<table><thead><tr>${entetes
    .map((h, i) => `<th${i ? ' class="n"' : ""}>${echapper(h)}</th>`)
    .join("")}</tr></thead><tbody>${lignes
    .map(
      (cellules) =>
        `<tr>${cellules
          .map((c, i) => `<td${i ? ' class="n"' : ""}>${echapper(c)}</td>`)
          .join("")}</tr>`
    )
    .join("")}</tbody></table>`;
}

const NOMS_CANAUX = {
  qr: "QR code",
  sig: "Signature email",
  partage: "Bouton partager",
  vcard: "vCard (contact)",
  direct: "Direct / inconnu",
};

async function pageStats(request, env) {
  if (!(await sessionValide(request, env))) {
    return new Response(pageConnexion(""), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const url = new URL(request.url);
  const demande = parseInt(url.searchParams.get("jours") || env.FENETRE_JOURS || "30", 10);
  const fenetre = [7, 30, 90].includes(demande) ? demande : 30;
  const s = await collecterStats(env, fenetre);

  const t = s.totaux;
  const visites = Number(t.visites) || 0;
  const visiteurs = Number(t.visiteurs) || 0;
  const clicsRdv = Number(t.clics_rdv) || 0;
  const interactions = Number(t.interactions) || 0;

  const onglet = (n, libelle) =>
    `<a href="/stats?jours=${n}" class="${n === fenetre ? "actif" : ""}">${libelle}</a>`;

  const contenu = `
<header class="titre">
  <div>
    <h1>Statistiques de la carte</h1>
    <p class="sous">David SERVAIS · Symbotis · ${fenetre} derniers jours (depuis le ${echapper(s.depuis)})</p>
  </div>
  <div class="onglets">${onglet(7, "7 j")}${onglet(30, "30 j")}${onglet(90, "90 j")}
    <a href="/deconnexion">Se déconnecter</a></div>
</header>

<div class="grille">
  <div class="tuile"><div class="valeur">${visites}</div><div class="label">Visites</div></div>
  <div class="tuile"><div class="valeur">${visiteurs}</div><div class="label">Visiteurs</div></div>
  <div class="tuile"><div class="valeur">${interactions}</div><div class="label">Interactions</div></div>
  <div class="tuile"><div class="valeur">${clicsRdv}</div><div class="label">Clics RDV</div></div>
  <div class="tuile"><div class="valeur">${pourcent(clicsRdv, visites)}</div><div class="label">Taux RDV</div></div>
</div>

<h2>Entonnoir de conversion</h2>
<div class="carte">${blocEntonnoir(s.entonnoir)}
  <p class="sous" style="margin-top:10px">Pourcentages calculés sur les visiteurs distincts, pas sur les clics.</p>
</div>

<h2>Visites par jour</h2>
<div class="carte">${graphique(s.parJour, fenetre)}</div>

<h2>Canaux d'arrivée</h2>
<div class="carte">${tableau(
    ["Canal", "Visites", "Visiteurs", "Clics RDV", "Taux RDV"],
    s.canaux.map((c) => [
      NOMS_CANAUX[c.src] || c.src,
      c.visites || 0,
      c.visiteurs || 0,
      c.clics_rdv || 0,
      pourcent(c.clics_rdv, c.visites),
    ]),
    "Aucune donnée sur la période."
  )}
  <p class="sous" style="margin-top:10px">« Direct / inconnu » : ouverture sans paramètre <code>?src=</code>.</p>
</div>

<h2>Détail des interactions</h2>
<div class="carte">${tableau(
    ["Événement", "Clics", "Visiteurs distincts"],
    s.evenements.map((e) => [e.nom, e.total || 0, e.visiteurs || 0]),
    "Aucune interaction sur la période."
  )}</div>

<h2>Pays</h2>
<div class="carte">${tableau(
    ["Pays", "Visiteurs"],
    s.pays.map((p) => [p.pays === "XX" ? "Inconnu" : p.pays, p.visiteurs || 0]),
    "Aucune donnée sur la période."
  )}</div>

<p class="pied">
  Mesure sans cookie et sans donnée personnelle : ni adresse IP ni user-agent ne sont
  stockés. Les visiteurs sont comptés via une empreinte hachée avec un sel secret et la
  date du jour, irréversible et renouvelée chaque nuit. Rétention ${RETENTION_JOURS} jours.
</p>`;

  return new Response(enveloppe("Statistiques de la carte", contenu), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function texte(message, statut) {
  return new Response(message, {
    status: statut,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
