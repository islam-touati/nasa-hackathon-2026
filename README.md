# Veille Feux

Prototype web pour le défi NASA Space Apps 2026 « Harmonization of MODIS and VIIRS Hot Spots ».

## Fonctionnalités

- L'interface web, ses messages d'erreur et les résultats de recherche géographique sont en anglais.
- Navigation principale : **Map** et **Notifications**. Les pages historiques existantes restent dans le code et leurs données ne sont pas supprimées, mais elles ne sont plus accessibles par la navigation principale.
- Les couleurs des hotspots décrivent la FRP observée : moins de 10 MW, de 10 à moins de 50 MW, au moins 50 MW, ou indisponible. Ce sont des seuils de visualisation arbitraires, pas des niveaux de danger. MODIS et VIIRS ne sont pas directement comparables.
- La carte affiche progressivement toutes les observations valides reçues pour la zone, la période récente et les capteurs sélectionnés, sans fusion ni sous-échantillonnage. VIIRS utilise le satellite choisi dans le menu. Des points peuvent se superposer : zoomer pour les distinguer. Les grandes zones sont chargées par tuiles non chevauchantes d'au plus 90° × 45° ; une tuile expirée est subdivisée en quatre zones, jusqu'à deux niveaux. Un échec persistant est signalé, sans afficher de résultat partiel. L'affichage mondial très dense peut prendre du temps ; il ne signifie pas que FIRMS détecte tous les feux.
- La période FIRMS est réglable de 1 à 5 jours (2 jours par défaut). Le nombre de lignes reçues de chaque source est affiché, y compris si une source ne renvoie aucune observation. Une réponse vide n'établit pas l'absence de feu ; choisir un autre satellite ou une période plus longue peut permettre de voir d'autres observations, sans remplacer silencieusement les données.
- L'onglet **Notifications** classe jusqu'à 50 détections FIRMS mondiales récentes selon leur repère historique pour les sept prochains jours UTC, sans sélection de point. Il interroge les quatre sources MODIS et VIIRS, sur la période FIRMS choisie sur la carte, indépendamment du zoom et des filtres de capteur. Il indique les détections reçues par source, le nombre sans repère et les mois utilisés. Une source indisponible interrompt le classement plutôt que de présenter un résultat mondial partiel. Pendant la préparation de l'index, l'onglet ouvert vérifie automatiquement sa disponibilité toutes les 30 secondes.
- Le bouton **View on map** d'une notification centre la carte sur la détection exacte, affiche ses détails et charge son contexte météo exploratoire. Le point sélectionné reste visible indépendamment de la zone et des filtres de capteur de la carte ; ces filtres restent inchangés pour les autres observations.
- Le repère compte les observations échantillonnées du même capteur dans la même case de 1° × 1° pendant le même mois de l'année précédente. Les satellites et produits historiques peuvent différer ou se chevaucher ; les cases varient en superficie selon la latitude. Chaque jour du même mois a le même repère. Si la semaine chevauche deux mois, le classement utilise le maximum des repères mensuels disponibles et affiche les deux valeurs ; une valeur absente reste indisponible. Les 50 premières détections sont des observations, pas des incendies uniques. Les seuils de couleur 1–9, 10–49 et ≥ 50 sont arbitraires et ne mesurent ni criticité ni risque futur. Couverture incomplète, échantillonnage et absence de repère ne signifient pas absence de feu. Aucun modèle prédictif, prévision météo ou envoi automatique de notification n'est utilisé pour ce classement.
- Carte mondiale interactive avec les détections NASA FIRMS dans la zone affichée.
- Couches MODIS et VIIRS sélectionnables ; le rapprochement indicatif des détections proches (≤ 550 m et ≤ 60 min) reste disponible dans le mode d'analyse des événements.
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

La météo historique n'est pas encore utilisée dans ces indicateurs. L'[API d'archives Open-Meteo](https://open-meteo.com/en/docs/historical-weather-api) propose notamment les réanalyses ERA5 et ERA5-Land : ce sont des estimations sur grille, pas des mesures de station locale. Une comparaison future exigerait notamment une couverture spatiale et temporelle adaptée, plusieurs années, des données explicatives supplémentaires et une validation indépendante.

## Lancer sur Windows

1. Installer [Node.js](https://nodejs.org/) (version 20.12 ou plus récente).
2. Ouvrir PowerShell dans ce dossier.
3. Obtenir la clé MAP_KEY gratuite NASA FIRMS par e-mail : [demander une clé](https://firms.modaps.eosdis.nasa.gov/api/map_key/).
4. Copier `.env.example` vers `.env`, puis renseigner `FIRMS_MAP_KEY=ta_cle` dans `.env`.
5. Pour conserver les archives historiques sur le serveur, installer PostgreSQL, créer une base et ajouter `DATABASE_URL=postgresql://...` dans `.env`.
6. Lancer `npm start` et ouvrir `http://localhost:4174`.
7. Pour l'analyse historique, télécharger des CSV depuis [les archives FIRMS](https://firms.modaps.eosdis.nasa.gov/download/), puis les importer dans PostgreSQL :

```powershell
npm run import:firms -- .\archives\modis_2020.csv .\archives\viirs_2020.csv
```

Le script crée automatiquement la table `firms_observations`, lit les CSV progressivement et écrit par lots de 250 observations avec une pause de 100 ms entre les lots. Il affiche la progression et le nombre réellement ajouté. Chaque lot est enregistré indépendamment : après interruption ou erreur, relancer la même commande reprend sans réinsérer les lignes déjà présentes. La reprise identifie les lignes par nom de fichier et numéro d'enregistrement : ne pas modifier le contenu ni réutiliser le même nom pour un autre fichier. Une erreur de lecture ou une observation invalide interrompt l'import ; les lots déjà enregistrés restent en base. L'import peut être long et consommer de l'espace disque et des ressources PostgreSQL malgré ces limites.

Le script accepte des fichiers **CSV**, pas les archives ZIP de shapefiles (`.dbf`, `.shp`, `.shx`). Vérifier l'espace disponible sur le disque de la base avant chaque import ; ne pas décompresser ni importer toutes les archives mondiales simultanément. `DATABASE_URL` doit être configurée dans `.env` ou dans l'environnement avant de démarrer. Pour les petits fichiers, l'endpoint `POST /api/history/import?file=nom.csv` accepte aussi le contenu CSV brut ; les fichiers de plus de 100 Mo doivent passer par le script.

### Import progressif des ZIP locaux sur Linux

Pour les quatre archives téléchargées dans ce projet, `scripts/import-all-firms.sh` lit directement les fichiers DBF présents dans les ZIP, sans les décompresser. Il requiert Python 3, Node.js, PostgreSQL et `df`. Les lots de 250 observations sont enregistrés séparément avec une pause de 100 ms. Les champs DBF originaux, le nom du ZIP, le nom du DBF et le numéro d'enregistrement sont conservés. Une relance reprend après le dernier enregistrement enregistré de chaque source : conserver les mêmes fichiers et ne pas les modifier. Ne pas lancer deux imports simultanés d'une même source.

Sur cet ordinateur, une instance PostgreSQL dédiée est installée localement dans `archives/postgresql-runtime`, et ses données sont dans `archives/postgresql-data` ; ces dossiers sont exclus de Git. Elle accepte uniquement les connexions par le socket privé `archives/postgresql-socket`, accessible au propriétaire. Après un redémarrage, la redémarrer depuis la racine du projet :

```sh
nice -n 15 ionice -c 3 ./archives/postgresql-runtime/usr/lib/postgresql/12/bin/pg_ctl \
  -D ./archives/postgresql-data -l ./archives/postgresql.log \
  -o "-c listen_addresses='' -c unix_socket_directories='$PWD/archives/postgresql-socket' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=10" start
```

Le chemin du socket de cette machine est configuré dans `.env`. Pour relancer les huit sources, depuis la racine, une seule fois :

```sh
nice -n 15 ionice -c 3 sh scripts/import-all-firms.sh >> archives/import-firms.log 2>&1
```

Consulter la progression et les erreurs avec `tail -n 30 archives/import-firms.log`. Le script arrête l'import quand moins de 8 Gio restent disponibles sur le disque du projet ; il ne vérifie pas l'espace d'une base située sur un autre disque. Les volumes mondiaux peuvent nécessiter beaucoup plus que l'espace disponible et prendre plusieurs heures. L'arrêt ne signifie donc pas que tous les fichiers ont été importés. Les produits archive et NRT peuvent se chevaucher : leurs observations restent distinctes, sans déduplication scientifique.

#### Échantillon léger de 5 %

Pour limiter le stockage tout en conservant les mois disponibles, `scripts/import-sample-firms.sh` sélectionne environ 5 % des observations de **chaque fichier source**. La sélection est reproductible : un hachage BLAKE2b-64 du nom de la source et du numéro d'enregistrement retient chaque ligne avec une probabilité de 5 %, indépendamment de la date et de la zone. Le nombre retenu varie donc selon le mois ; aucun minimum par mois ni par zone n'est garanti. Les données réelles sélectionnées sont stockées séparément dans `firms_sample_observations` ; les données complètes préexistantes ne sont ni modifiées ni mélangées. Le plan est enregistré dans `firms_sample_plan`. Les sources sont lues en entier, mais sans extraction ; l'import reste long et s'arrête au même seuil de disque.

```sh
nice -n 15 ionice -c 3 sh scripts/import-sample-firms.sh >> archives/import-sample-firms.log 2>&1
```

Le journal indique la progression par source ; l'absence de message final indique un traitement incomplet ou interrompu. Relancer la même commande reprend après le dernier enregistrement sélectionné et enregistré pour chaque source. Ne pas modifier les ZIP ni changer leur nom. Les nombres dans la table sont des **observations échantillonnées**, pas des totaux mensuels ; les périodes rares, zones peu couvertes et événements isolés peuvent être absents. Les produits NRT et archive peuvent se chevaucher. Un échantillon sur environ une année ne permet ni comparaison interannuelle fiable ni prévision validée.

#### Préparation de comptages géographiques

Le script `scripts/index-history-cells.mjs` prépare en base des comptages de l'échantillon par source, capteur, mois UTC et case de 1° de latitude × 1° de longitude. Il ne modifie pas les observations. Les cases n'ont pas toutes la même superficie ; ces comptages ne sont ni une prédiction ni un niveau de danger, et les chevauchements entre produits restent présents. Les notifications n'utilisent cet index que lorsque toutes les sources sont terminées.

Sur Linux, avec Node.js 22 et PostgreSQL en fonctionnement :

```sh
nice -n 19 ionice -c 3 node scripts/index-history-cells.mjs
```

Le traitement travaille par lots transactionnels de 500 lignes avec une pause, une seule source à la fois. Il peut être long ; une interruption puis une relance reprennent au dernier lot enregistré. Un nombre maximal de lots peut être fourni en argument pour faire une pause contrôlée. Le script s'arrête si moins de 8 Gio restent sur le disque du projet ou si une source a changé depuis le début de son indexation ; il ne vérifie pas l'espace d'une base sur un autre disque. Ne pas modifier ni remplacer les observations indexées et ne pas importer de nouvelles données pendant la préparation. Un traitement interrompu est incomplet, et un index doit être reconstruit avant usage si ses sources ont changé.

Dans **Data & method → View the FIRMS sample**, le bouton « Show observations » permet de vérifier jusqu'à 50 lignes stockées dans PostgreSQL. Un mois et un capteur peuvent être choisis pour cet aperçu indépendant. Actualiser manuellement pour voir les nouvelles lignes importées. Ce tableau ne remplit pas le calendrier, les analyses ou la carte, qui utilisent toujours les archives locales du navigateur.

Dans **Analyses → Repère pour le mois prochain**, un scénario mondial reprend le nombre d'observations échantillonnées du même mois un an auparavant, sans extrapolation au total réel. Les sources et satellites sont affichés séparément ; leurs observations sont additionnées sans rapprochement ni déduplication et peuvent se chevaucher. La date de référence utilise le mois suivant en UTC. Sans observation pour le mois de référence, aucun chiffre n'est produit. La couverture n'est pas vérifiée et le résultat peut être incomplet ; il ne constitue ni une prévision validée ni un nombre d'incendies. Le scénario est indépendant des filtres et données du navigateur. Plusieurs années et une validation adaptée seraient nécessaires pour envisager un modèle prédictif.

Sur la **Map**, pour explorer un jour futur autour d'un point passé, ouvrir **Data & method → View the FIRMS sample**, puis cliquer sur « Choose this point » dans une ligne. Choisir ensuite un jour futur en UTC et cliquer sur « Show historical context ». La carte montre dans un rayon de 50 km les observations échantillonnées du même mois de l'année précédente (maximum 500, indication visible si le résultat est tronqué). Tous les capteurs sont inclus indépendamment des filtres de la carte ; les observations de différentes sources peuvent se chevaucher. La carte ne représente pas les observations comme des détections futures : aucune prévision météo ou comparaison de chaleur n'est calculée pour le jour choisi. Les dates, capteurs, satellites et provenances réels sont consultables sur les points. Une absence de données n'est pas une absence de feu ; l'échantillon, la couverture et les produits disponibles peuvent être incomplets.

Le serveur local utilise Node.js et le pilote PostgreSQL `pg`. Son port par défaut est `4174` (modifiable avec `PORT` dans `.env`). NASA FIRMS est le seul service externe qui nécessite une clé ; la clé est lue par le serveur depuis `.env` et ne passe pas dans le navigateur. Les tuiles OSM, la recherche et les API météo nécessitent une connexion Internet. Open-Meteo est gratuit sans clé pour un usage non commercial (limite d’usage équitable) ; une utilisation commerciale nécessite une offre adaptée.

Les archives importées par le script sont conservées dans PostgreSQL. L'interface historique actuelle utilise le stockage IndexedDB du navigateur et ne lit pas encore ces archives PostgreSQL : un import en base ne les affiche donc pas automatiquement dans les graphiques. Pour les grandes séries, importer les fichiers par région ou par lots d'années. Une seule année de données, même mondiale, ne suffit pas à établir une tendance historique fiable ni à prédire les détections futures.

## Interprétation et limites

Une détection FIRMS est une anomalie thermique repérée au passage d'un satellite, et non le contour exact d'un feu. Un endroit sans détection n'est pas une preuve d'absence de feu. MODIS et VIIRS n'ont pas la même résolution, sensibilité ou fréquence de passage ; l'application garde la provenance et montre les différences par capteur. Le rapprochement temps-réel de points proches est une aide d'exploration, pas une calibration scientifique équivalente des instruments. Les graphiques des archives comptent des observations FIRMS, pas des incendies uniques.

La zone bleue illustre la direction et un corridor plausible au regard du vent et de quelques variables météo. Sa distance utilise une heuristique visuelle. Ce n'est ni un modèle validé de propagation, ni une prévision opérationnelle : le relief, le type et l'humidité des combustibles, les pare-feu et l'action des secours ne sont pas modélisés. Toujours consulter les autorités et les services de secours pour une situation réelle.

## Sources

- Détections actives : [NASA FIRMS Area API](https://firms.modaps.eosdis.nasa.gov/api/) — nécessite une clé MAP_KEY gratuite.
- Archives de détections : fichiers CSV NASA FIRMS choisis et importés par l'utilisateur.
- Prévisions météo : [Open-Meteo Forecast API](https://open-meteo.com/en/docs) et recherche de lieux [Open-Meteo Geocoding API](https://open-meteo.com/en/docs/geocoding-api).
- Fond cartographique : tuiles [OpenStreetMap](https://www.openstreetmap.org/copyright), avec attribution affichée sur la carte.
- Bibliothèques d'interface : [Leaflet](https://leafletjs.com/) et [Leaflet Draw](https://github.com/Leaflet/Leaflet.draw), chargées depuis [unpkg](https://unpkg.com/).
- Polices : [DM Sans](https://fonts.google.com/specimen/DM+Sans) et [DM Mono](https://fonts.google.com/specimen/DM+Mono), chargées depuis Google Fonts.

## Arborescence

- `server.mjs` — serveur local et proxy API (la clé FIRMS est lue depuis `.env` côté serveur, jamais transmise au navigateur).
- `index.html`, `style.css`, `app.js` — interface et logique cartographique.
