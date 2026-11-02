# Veille Feux

Prototype web pour le défi NASA Space Apps 2026 « Harmonization of MODIS and VIIRS Hot Spots ».

## Fonctionnalités

- Carte mondiale interactive avec les détections NASA FIRMS dans la zone affichée.
- Couches MODIS et VIIRS sélectionnables, avec fusion indicative des détections proches (≤ 550 m et ≤ 60 min) en un seul événement.
- Détails d'une détection : satellite, date/heure, confiance et puissance radiative.
- Sélection d'un foyer et projection horaire sur 72 h à l'aide du vent, de la température, de l'humidité et des précipitations prévus.
- Zone d'étude sélectionnable par dessin sur la carte ou par coordonnées nord/sud/ouest/est.
- Import local de plusieurs CSV FIRMS dans le navigateur pour créer un calendrier historique long.
- Calendrier annuel × mensuel, barres d'activité par année, profil saisonnier, jour le plus actif, composition MODIS/VIIRS et médiane de FRP.
- Comparaison du mois avec la médiane du même mois des années historiques disponibles.
- Filtres de période, zone, capteur et mesure (nombre de détections ou somme de FRP) avec export des lignes filtrées en CSV.
- Mode d’analyse des événements proches : rapprochement spatial et temporel exploratoire (≤ 550 m et ≤ 60 min) pour réduire les doublons potentiels entre capteurs.
- Vue carte distincte entre les observations récentes NRT et les archives importées, consultables par année.
- Recherche de villes, régions et pays via Open-Meteo Geocoding (sans clé), avec cadrage cartographique adapté.
- Fond de carte OpenStreetMap (sans clé) avec attribution visible.
- Prévisions météorologiques horaires Open-Meteo (sans clé pour un usage non commercial).

## Lancer sur Windows

1. Installer [Node.js](https://nodejs.org/) (version 20.12 ou plus récente).
2. Ouvrir PowerShell dans ce dossier.
3. Obtenir la clé MAP_KEY gratuite NASA FIRMS par e-mail : [demander une clé](https://firms.modaps.eosdis.nasa.gov/api/map_key/).
4. Copier `.env.example` vers `.env`, puis renseigner `FIRMS_MAP_KEY=ta_cle` dans `.env`.
5. Lancer `npm start` et ouvrir `http://localhost:4174`.
6. Pour l'analyse historique, ouvrir « Données & méthode », télécharger des CSV depuis [les archives FIRMS](https://firms.modaps.eosdis.nasa.gov/download/), puis importer les fichiers téléchargés. Tu peux charger plusieurs années et les deux capteurs.

Le serveur local utilise uniquement les modules intégrés de Node.js. Son port par défaut est `4174` (modifiable avec `PORT` dans `.env`). NASA FIRMS est le seul service qui nécessite une clé dans cette configuration. La clé est lue par le serveur depuis `.env`, ne passe pas dans le navigateur, et `.env` est ignoré par Git. Les tuiles OSM, la recherche et les API météo nécessitent une connexion Internet. Open-Meteo est gratuit sans clé pour un usage non commercial (limite d’usage équitable) ; une utilisation commerciale nécessite une offre adaptée.

Les archives importées sont conservées dans le stockage IndexedDB du navigateur. Elles ne sont pas envoyées au serveur Veille Feux. La capacité dépend de l'espace disponible par navigateur ; pour les grandes séries, importer les fichiers par région ou par lots d'années.

## Interprétation et limites

Une détection FIRMS est une anomalie thermique repérée au passage d'un satellite, et non le contour exact d'un feu. Un endroit sans détection n'est pas une preuve d'absence de feu. MODIS et VIIRS n'ont pas la même résolution, sensibilité ou fréquence de passage ; l'application garde la provenance et montre les différences par capteur. Le rapprochement temps-réel de points proches est une aide d'exploration, pas une calibration scientifique équivalente des instruments. Les graphiques des archives comptent des observations FIRMS, pas des incendies uniques.

La zone bleue illustre la direction et un corridor plausible au regard du vent et de quelques variables météo. Sa distance utilise une heuristique visuelle. Ce n'est ni un modèle validé de propagation, ni une prévision opérationnelle : le relief, le type et l'humidité des combustibles, les pare-feu et l'action des secours ne sont pas modélisés. Toujours consulter les autorités et les services de secours pour une situation réelle.

## Sources

- Détections actives : [NASA FIRMS Area API](https://firms.modaps.eosdis.nasa.gov/api/) — nécessite une clé MAP_KEY gratuite.
- Prévisions météo : [Open-Meteo Forecast API](https://open-meteo.com/en/docs).
- Fond cartographique : [OpenStreetMap](https://www.openstreetmap.org/) / [CARTO](https://carto.com/attributions).

## Arborescence

- `server.mjs` — serveur local et proxy API (clé FIRMS fournie dans les réglages du navigateur).
- `index.html`, `style.css`, `app.js` — interface et logique cartographique.
