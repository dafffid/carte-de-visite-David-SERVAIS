/**
 * Déploiement du Worker de statistiques, en une passe et idempotent.
 *
 *   node deployer.mjs
 *
 * 1. crée la base D1 « carte-stats » si elle n'existe pas
 * 2. injecte son identifiant dans wrangler.toml
 * 3. applique schema.sql sur la base distante
 * 4. génère les trois secrets s'ils manquent et les pousse dans Cloudflare
 * 5. range le mot de passe du tableau de bord dans le coffre Bitwarden
 * 6. déploie le Worker
 *
 * Aucun secret n'est affiché : ni dans la sortie, ni dans un fichier du dépôt.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ICI = dirname(fileURLToPath(import.meta.url));
const TOML = join(ICI, "wrangler.toml");
const NOM_BASE = "carte-stats";
const ITEM_COFFRE = "CARTE_STATS";

const VAULT = join(
  process.env.USERPROFILE || process.env.HOME,
  ".claude/plugins/marketplaces/local-desktop-app-uploads/hypervibe/scripts/vault/vault.mjs"
);

function etape(message) {
  console.log(`\n=== ${message} ===`);
}

function wrangler(args, options = {}) {
  return execFileSync("npx", ["--yes", "wrangler", ...args], {
    cwd: ICI,
    encoding: "utf8",
    shell: true,
    stdio: options.entree ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input: options.entree,
  });
}

/* ---- 1. Base D1 ---------------------------------------------------- */

function idBaseExistante() {
  try {
    const sortie = wrangler(["d1", "list", "--json"]);
    const bases = JSON.parse(sortie.slice(sortie.indexOf("[")));
    const base = bases.find((b) => b.name === NOM_BASE);
    return base ? base.uuid : null;
  } catch {
    return null;
  }
}

function creerBase() {
  const sortie = wrangler(["d1", "create", NOM_BASE]);
  const trouve = sortie.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!trouve) throw new Error("Identifiant D1 introuvable dans la sortie de wrangler");
  return trouve[0];
}

etape("Base de données D1");
let idBase = idBaseExistante();
if (idBase) {
  console.log(`base « ${NOM_BASE} » déjà présente`);
} else {
  idBase = creerBase();
  console.log(`base « ${NOM_BASE} » créée`);
}
console.log(`identifiant : ${idBase}`);

/* ---- 2. wrangler.toml ---------------------------------------------- */

etape("Configuration");
const toml = readFileSync(TOML, "utf8");
const majToml = toml.replace(/database_id = "[^"]*"/, `database_id = "${idBase}"`);
if (majToml !== toml) {
  writeFileSync(TOML, majToml);
  console.log("wrangler.toml mis à jour");
} else {
  console.log("wrangler.toml déjà à jour");
}

/* ---- 3. Schéma ------------------------------------------------------ */

etape("Application du schéma");
wrangler(["d1", "execute", NOM_BASE, "--remote", "--file=schema.sql", "--yes"]);
console.log("schema.sql appliqué (les CREATE sont en IF NOT EXISTS, rejouable sans risque)");

/* ---- 4. Secrets ------------------------------------------------------ */

function secretsExistants() {
  try {
    const sortie = wrangler(["secret", "list"]);
    return JSON.parse(sortie.slice(sortie.indexOf("["))).map((s) => s.name);
  } catch {
    return [];
  }
}

/** Mot de passe lisible à la voix : pas d'ambiguïté 0/O ni 1/l/I. */
function motDePasseLisible(nbGroupes = 4) {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const octets = randomBytes(nbGroupes * 5);
  const groupes = [];
  for (let g = 0; g < nbGroupes; g++) {
    let mot = "";
    for (let i = 0; i < 5; i++) mot += alphabet[octets[g * 5 + i] % alphabet.length];
    groupes.push(mot);
  }
  return groupes.join("-");
}

etape("Secrets Cloudflare");
const deja = secretsExistants();
const aPousser = [];

let motDePasse = null;
if (!deja.includes("MOTDEPASSE")) {
  motDePasse = motDePasseLisible();
  aPousser.push(["MOTDEPASSE", motDePasse]);
} else {
  console.log("MOTDEPASSE déjà défini, conservé");
}
for (const nom of ["SECRET_SESSION", "SEL_EMPREINTE"]) {
  if (!deja.includes(nom)) aPousser.push([nom, randomBytes(32).toString("hex")]);
  else console.log(`${nom} déjà défini, conservé`);
}

for (const [nom, valeur] of aPousser) {
  wrangler(["secret", "put", nom], { entree: valeur + "\n" });
  console.log(`${nom} poussé`);
}

/* ---- 5. Coffre-fort -------------------------------------------------- */

if (motDePasse) {
  etape("Enregistrement dans le coffre-fort");
  try {
    const { putItem } = await import("file:///" + VAULT.replace(/\\/g, "/"));
    putItem(
      ITEM_COFFRE,
      [
        { name: "motdepasse", value: motDePasse, type: "secret" },
        { name: "url", value: "https://carte-stats.david-servais80.workers.dev/stats", type: "text" },
      ],
      { service: "Statistiques carte de visite Symbotis", folder: "Global" }
    );
    console.log(`mot de passe rangé dans le coffre sous « ${ITEM_COFFRE} », champ « motdepasse »`);
  } catch (e) {
    console.log(`ATTENTION : écriture dans le coffre impossible (${e.message}).`);
    console.log("Le mot de passe est actif côté Cloudflare mais n'est stocké nulle part.");
    console.log("Relancez la commande de rotation pour en générer un nouveau et le ranger.");
  }
}

/* ---- 6. Déploiement --------------------------------------------------- */

etape("Déploiement du Worker");
const sortieDeploiement = wrangler(["deploy"]);
const urlTrouvee = sortieDeploiement.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
console.log(sortieDeploiement.trim().split("\n").slice(-6).join("\n"));

etape("Terminé");
console.log(`Tableau de bord : ${urlTrouvee ? urlTrouvee[0] : "(url non détectée)"}/stats`);
console.log(`Mot de passe    : coffre Bitwarden, item ${ITEM_COFFRE}, champ motdepasse`);
