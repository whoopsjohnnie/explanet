-- ===========================================================================
-- Migration 006 — stars  (the real-sky catalog, Yale BSC v5)
-- ===========================================================================
-- Reference table for the real sky (StarField.jsx / core/starsky.js), kept
-- OUTSIDE the world tables: a star here is a fact about our galaxy, not a
-- body inside a world document. The `catalog` column groups rows by source
-- catalog — the lightweight stand-in for a future star-map/galaxy table, so
-- richer surveys (Hipparcos, Gaia) can land beside the BSC without a schema
-- change. Natural key (catalog, hr); re-imports replace one catalog atomically.
--
-- Frame semantics (all angles in DEGREES, ICRS/FK5 at J2000):
--   ra_deg / dec_deg   equatorial — the catalog's own coordinates; the app
--                      projects them to the engine frame (ecliptic XZ plane,
--                      +Y ecliptic north) in starsky.js.
--   epoch              equinox of the positions, Julian years (2000.0 = J2000).
--   pm_ra / pm_dec     proper motion as catalogued (arcsec/yr; NULL unknown).
--   mag                Johnson V apparent magnitude (mag_band says which).
--   b_v                Johnson B−V colour index, NULL when the catalog lacks
--                      it (the YBS5 JSON has no colours; the app tints by
--                      spectral class instead).
--   spectral           classification string as catalogued ("K0III", "M2Iab",
--                      variable-star prefixes and all); spectral_class is the
--                      OBAFGKM letter extracted from it (NULL = uncatalogued),
--                      the index the renderer colors from.
--   gal_l / gal_b      galactic longitude/latitude (IAU 1958 system), and
--   ecl_lon / ecl_lat  ecliptic longitude/latitude (J2000, λ from the vernal
--                      equinox = the engine frame's own spherical coords) —
--                      DERIVED conveniences computed at import with the app's
--                      starsky.js (radecToGalactic / radecToEcliptic) so SQL
--                      can band-cut ("all stars within 5° of the galactic
--                      plane") without re-doing the astronomy. Derivable,
--                      never authoritative.
--
-- Apply:  PGPASSWORD=*** psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
--           -f db/migrations/006-stars.sql
-- Idempotent. Fresh installs get this from db/schema.sql directly.
-- ===========================================================================
BEGIN;

SET search_path = explanet;
SET LOCAL client_min_messages = warning;

CREATE TABLE IF NOT EXISTS stars (
  catalog         text    NOT NULL,                -- 'BSC5' = Yale Bright Star Catalog v5
  hr              integer NOT NULL,                -- Harvard Revised number (the BSC id)

  ra_deg          double precision NOT NULL CHECK (ra_deg >= 0 AND ra_deg < 360),
  dec_deg         double precision NOT NULL CHECK (dec_deg BETWEEN -90 AND 90),
  epoch           double precision NOT NULL DEFAULT 2000,
  pm_ra           double precision,
  pm_dec          double precision,

  mag             double precision NOT NULL CHECK (mag BETWEEN -30 AND 30),
  mag_band        text NOT NULL DEFAULT 'V',
  b_v             double precision,

  spectral        text,
  spectral_class  text CHECK (spectral_class IS NULL OR spectral_class IN
                              ('O', 'B', 'A', 'F', 'G', 'K', 'M')),

  -- derived at import (starsky.js) — query convenience, never authoritative
  gal_l           double precision,
  gal_b           double precision,
  ecl_lon         double precision,
  ecl_lat         double precision,

  imported_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (catalog, hr)
);

-- the hot query is "this catalog, brightest first" (sky payload, magMax cuts)
CREATE INDEX IF NOT EXISTS stars_by_mag_idx ON stars (catalog, mag);

COMMENT ON TABLE stars IS
  'Real-sky star catalog (astronomy, not world content): one row per star of '
  'a catalog. Positions J2000 equatorial; gal_/ecl_ columns derived at import '
  'via src/core/starsky.js. Served by GET /api/stars* — the app projects '
  'ra/dec into the engine ecliptic frame at load time.';
COMMENT ON COLUMN stars.catalog IS
  'Source catalog id, e.g. BSC5 = Yale Bright Star Catalog v5 (public domain). '
  'Groups rows until a proper star-map/galaxy model exists.';
COMMENT ON COLUMN stars.spectral IS
  'Classification string as catalogued; spectral_class is its OBAFGKM letter '
  '(NULL = unknown), the color index StarField.jsx uses.';

COMMIT;
