-- Schéma des statistiques de la carte de visite Symbotis (Cloudflare D1).
--
-- Aucune donnée personnelle n'est stockée : pas d'adresse IP, pas de
-- user-agent, pas de cookie visiteur. La colonne `empreinte` est un hash
-- SHA-256 tronqué de (sel secret + jour + IP + user-agent). Le sel est un
-- secret du Worker et le jour change toutes les 24 h : l'empreinte est donc
-- irréversible et non rattachable d'un jour sur l'autre.

CREATE TABLE IF NOT EXISTS evenement (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nom         TEXT NOT NULL,                      -- visite, clic-rdv, lien-nos-services...
  src         TEXT NOT NULL DEFAULT 'direct',     -- qr, partage, vcard, sig, direct
  pays        TEXT,                               -- code ISO fourni par Cloudflare
  empreinte   TEXT NOT NULL,                      -- hash quotidien, voir ci-dessus
  jour        TEXT NOT NULL,                      -- AAAA-MM-JJ (UTC)
  horodatage  TEXT NOT NULL                       -- ISO 8601 (UTC)
);

CREATE INDEX IF NOT EXISTS idx_evenement_jour ON evenement (jour);
CREATE INDEX IF NOT EXISTS idx_evenement_nom  ON evenement (nom);
CREATE INDEX IF NOT EXISTS idx_evenement_src  ON evenement (src);
CREATE INDEX IF NOT EXISTS idx_evenement_jour_nom ON evenement (jour, nom);
