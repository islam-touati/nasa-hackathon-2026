#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
printf 'Échantillonnage FIRMS à 5 %% démarré : %s\n' "$(date -Is)"

node scripts/import-firms-zip.mjs DL_FIRE_M-C61_849832.zip fire_archive_M-C61_849832.dbf 5
node scripts/import-firms-zip.mjs DL_FIRE_M-C61_849832.zip fire_nrt_M-C61_849832.dbf 5
node scripts/import-firms-zip.mjs DL_FIRE_J1V-C2_849833.zip fire_archive_J1V-C2_849833.dbf 5
node scripts/import-firms-zip.mjs DL_FIRE_J1V-C2_849833.zip fire_nrt_J1V-C2_849833.dbf 5
node scripts/import-firms-zip.mjs DL_FIRE_J2V-C2_849834.zip fire_archive_J2V-C2_849834.dbf 5
node scripts/import-firms-zip.mjs DL_FIRE_J2V-C2_849834.zip fire_nrt_J2V-C2_849834.dbf 5
node scripts/import-firms-zip.mjs DL_FIRE_SV-C2_849835.zip fire_archive_SV-C2_849835.dbf 5
node scripts/import-firms-zip.mjs DL_FIRE_SV-C2_849835.zip fire_nrt_SV-C2_849835.dbf 5
printf 'Échantillonnage FIRMS terminé : %s\n' "$(date -Is)"
