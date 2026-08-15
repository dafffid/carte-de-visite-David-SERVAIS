# Prompt à coller dans Claude Code

> Lancez Claude Code depuis le dossier contenant les 5 fichiers de la carte
> (`cd C:\Users\pc\carte-symbotis` puis `claude`), remplacez les deux valeurs
> entre crochets de la première ligne, et collez tout ce qui suit.

---

Mon code GoatCounter est [carte-david] et je veux nommer le dépôt GitHub [carte-de-visite].

Tu es dans un dossier contenant ma carte de visite digitale : `index.html`
(page autonome avec un bloc `CONFIG` en tête, photo et logo embarqués en
base64, QR code généré en JS depuis l'URL de la page), `sw.js` (service
worker de cache), `manifest.json`, `icon-192.png`, `icon-512.png`.

Réalise de bout en bout, sans me demander d'écrire du code moi-même :

## 0. Vérifications préalables
- Vérifie que `git`, `gh` et `node` sont installés. S'il en manque, indique-moi
  précisément comment les installer sous Windows, puis attends que je confirme.
- Vérifie l'authentification GitHub avec `gh auth status`. Si je ne suis pas
  connecté, lance `gh auth login` et guide-moi (je m'authentifie moi-même dans
  le navigateur ; ne me demande jamais de mot de passe).

## 1. Instrumentation analytics (GoatCounter)
Modifie `index.html` :
- Ajoute le script GoatCounter officiel en fin de body :
  `<script data-goatcounter="https://MONCODE.goatcounter.com/count" async src="https://gc.zgo.at/count.js"></script>`
  en remplaçant MONCODE par mon code GoatCounter ci-dessus.
- Crée une petite fonction `track(nom)` qui envoie un événement personnalisé
  via `window.goatcounter.count({ path: nom, event: true })`, sans jamais
  faire échouer la page si GoatCounter n'est pas chargé (try/catch + test
  d'existence). Ne bloque aucune navigation : pour les liens `tel:`, `sms:`,
  `mailto:` et externes, l'événement part en parallèle, sans preventDefault.
- Instrumente avec des noms d'événements explicites :
  `clic-appeler`, `clic-sms`, `clic-email`, `clic-whatsapp`, `clic-siteweb`,
  `clic-vcard`, `clic-rdv`, `clic-rdv-flottant`, `clic-partager`, un événement
  par lien de la section écosystème (`lien-<slug du titre>`), et un par réseau
  social (`social-<nom>`).
- Traçage des canaux d'arrivée : le QR code doit désormais encoder l'URL de la
  page suffixée de `?src=qr` (mais l'URL affichée/partagée reste propre) ; le
  bouton Partager et la vCard doivent diffuser l'URL avec `?src=partage` et
  `?src=vcard` respectivement. GoatCounter enregistre le paramètre de requête
  automatiquement, ne rien coder de plus côté collecte.
- Respecte le caractère hors-ligne : la page doit fonctionner à l'identique
  sans réseau (le script analytics est `async` et optionnel).

## 2. Service worker
- Dans `sw.js`, incrémente le nom du cache (v1 -> v2) pour forcer la mise à
  jour chez les visiteurs existants, et assure-toi que les requêtes vers
  `goatcounter.com` et `gc.zgo.at` ne sont jamais interceptées ni mises en
  cache (network-only).

## 3. Dépôt et déploiement GitHub Pages
- `git init` si nécessaire, commit de tous les fichiers avec un message clair.
- Crée le dépôt public sur mon compte avec `gh repo create <nom> --public
  --source=. --push`.
- Active GitHub Pages sur la branche main, racine, via
  `gh api repos/{owner}/{repo}/pages -X POST -f "source[branch]=main" -f "source[path]=/"`
  (ou la commande équivalente qui fonctionne).
- Attends que le site réponde (boucle de vérification HTTP sur l'URL Pages,
  max 3 minutes), puis vérifie que la page contient bien le script GoatCounter.

## 4. Recette et restitution
- Ouvre l'URL finale dans mon navigateur par défaut.
- Affiche un récapitulatif : URL publique de la carte, URL de mon tableau de
  bord GoatCounter (https://MONCODE.goatcounter.com), liste des événements
  trackés, et comment tester (visiter la page, cliquer 2-3 boutons, vérifier
  leur apparition dans le dashboard sous ~30 secondes).
- Dis-moi quelle URL exacte utiliser dans ma signature email
  (celle avec `?src=sig`) pour distinguer ce canal dans les stats.

## Contraintes
- Ne touche à rien d'autre dans `index.html` : design, CONFIG, photo, logo et
  fonctionnement hors-ligne doivent rester strictement identiques.
- Aucune donnée personnelle des visiteurs ne doit être collectée (pas de
  cookies, pas d'identifiants) : uniquement les compteurs anonymes GoatCounter.
- Si une étape échoue, diagnostique, corrige et réessaie avant de me solliciter.
- À la fin, propose-moi (sans le faire) le plan pour l'évolution « palier 2 » :
  endpoint Cloudflare Workers + D1 et page stats.html privée.
