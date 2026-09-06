# PRD — Voituros

> Jeu vidéo 2D de physics minimaliste, dark theme.
> Stack imposée : `pixi.js@8.20.1` + `@dimforge/rapier2d-compat@0.20.0` + `vite@8.2.2` + `@playwright/test@1.62.1`, Node 26, ES modules.
> App : page web fullscreen, 60fps, monde plus grand que la vue, caméra intelligente.

---

## 1. Vision & objectifs

* **Nom :** Voituros.
* **Pitch :** Conduire une petite voiture low-poly sur une route-ligne générée procéduralement. Aller le plus loin possible sans se retourner.
* **Piliers :** (1) physics crédible, (2) minimaliste lisible, (3) rejouabilité (route + voiture aléatoires, 3 difficultés).
* **Non-objectifs V1 :** pas de multijoueur réseau, pas de backend, pas d'assets externes, pas de son obligatoire (un bip optionnel toléré), pas d'éditeur de niveau.

## 2. Personas & parcours

* Joueur occasionnel : ouvre la page, voit immédiatement la voiture au départ, comprend en < 5s (flèches / A-D), roule, se retourne, respawn.
* Parcours : Landing/jeu immédiat → choix difficulté (Easy/Medium/Hard, défaut Medium) → drive → flip 3s → mort → pierre tombale + distance → respawn auto au début avec nouvelle voiture → best score persisté (localStorage).

## 3. Exigences fonctionnelles

### 3.1 Écran & shell

* `index.html` : `#app` fullscreen 100vw/100vh, fond `#0b0e14`, canvas Pixi redimensionné au window resize (devicePixelRatio capped à 2).
* HUD DOM (au-dessus du canvas, CSS pur, pas de lib UI) :
  * Top-left : `VOITUROS` + `distance: XXX m` + `best: YYY m`.
  * Top-center : sélecteur difficulté : 3 boutons `[Easy|Medium|Hard]` + bouton `[Nouvelle route]` + seed affichée `#123456`.
  * Top-right : bouton `[Recommencer]` + aide `◀ ▶ / A D pour rouler • R restart`.
  * Bottom-center (contextuel) : avertissement retournement `⚠ Retourné ! 2.1s` + barre de progression 3s.
  * Toast mort : `💀 Retourné ! 123 m — nouvelle voiture…`.
* Tous les éléments HUD doivent avoir des `data-testid` stables (cf. §9) pour Playwright.
* Responsive : jouable ≥ 360px de large. Pas de scroll page (`overflow:hidden`).

### 3.2 Monde & route procédurale

* La route est **une ligne** (rendue comme trait épais lumineux + remblai sombre), **continue, dérivable par morceaux, sans trous ni sauts verticaux**, de longueur fixe `TRACK_LENGTH = 12000 px` (≈ 1200 m à `PX_PER_M = 10`).
* Origine : zone plate de 400 px à `x ∈ [−200, 200]` à `y=0` pour le spawn.
* **Algorithme imposé (cohérent + difficulté) : somme de sinusoïdes seedées + bruit de valeur 1D lissé (fBm léger).**
  * RNG seedé `mulberry32(seed)` — même seed ⇒ même route.
  * Fonction hauteur :
    `y(x) = A1·sin(2π·x/L1 + φ1) + A2·sin(2π·x/L2 + φ2) + A3·vnoise1D(x·f + offset)·enveloppe(x)`
    où `vnoise1D` = interpolation cosinus entre valeurs hashées tous les `STEP_NOISE` px, `fBm` = 2 octaves max pour rester carrossable.
  * Enveloppe de démarrage : amplitude × `smoothstep(x, 200, 800)` pour garantir le plat du départ.
  * Paramètres par difficulté :

    | Param | Easy | Medium | Hard |
    |---|---|---|---|
    | A1 (grande ondulation) | 45 | 90 | 140 |
    | L1 | 1100 | 900 | 750 |
    | A2 (bosses) | 12 | 35 | 70 |
    | L2 | 320 | 260 | 200 |
    | A3 (rugosité noise) | 0 | 18 | 45 |
    | STEP_NOISE | — | 140 | 90 |
    | Pente max cible | ≤ 20° | ≤ 35° | ≤ 50° |
    | Épaisseur visuelle route | 10px | 10px | 10px |
  * Échantillonnage : un point tous les `DX = 20 px` ⇒ ~600 points pour 12000 px. Pente clampée : si `|dy/dx|` dépasse `tan(penteMax)`, on écrête `dy` (garantit carrossabilité + cohérence). Limiteur de courbure (Δdy ≤ `DX·tan(10°)` par pas) + 2 passes binomiales : aucun angle dur aux joints (cassures ≤ ~10°), sans changer l'échantillonnage ni le déterminisme.
  * Colliders Rapier : pour chaque segment `[p_i, p_{i+1}]`, un `ColliderDesc.cuboid(halfLen, thickness/2)` positionné au milieu, rotaté à l'angle du segment. `thickness = 20px`, `friction = 1.2`, `restitution = 0`. Corps `fixed()`. Groupe de collision route = 0x0001.
  * Rendu Pixi : (a) remblai : polygone sous la ligne (jusqu'à +2000px vers le bas) couleur `#141a26`, (b) ligne : `Graphics.polyline` épaisseur 6px couleur par difficulté (Easy `#34d399`, Medium `#60a5fa`, Hard `#f472b6`), glow léger via second trait alpha 0.25 épaisseur 12px. Départ : drapeau / marquage blanc à x=0. Distance markers tous les 100 m (petits ticks + label `100m`, …).
* API attendue `src/route.js` : `generateRoute(seed, difficulty) → { points: [{x,y}], seed, difficulty }`, `buildRouteColliders(world, points) → void`, `drawRoute(graphics, points, difficulty) → void`, `routeYAt(points, x) → y` (interpolation linéaire). Exporter `DIFFICULTIES`, `TRACK_LENGTH`, `PX_PER_M`.

### 3.3 Voiture aléatoire (1 voiture / player, V1 = 1 player local)

* Chaque voiture 2D low-poly comprend **exactement** :
  * 1 carrosserie : polygone convexe/legèrement concave de 5–7 sommets, style berline/hatchback anguleux. Dimensions random : longueur 70–110 px, hauteur 22–38 px. Couleur random parmi palette néon sombre (`#f43f5e #f59e0b #22d3ee #a78bfa #a3e635 #f472b6`), contour `#e5e7eb` 2px.
  * 1 phare à l'avant : lampe `#fff7d6` + halo additif, projecteur réaliste :
  * faisceau raycasté (56 rayons sur ±15°, incliné ~8° vers le sol,
  * portée 380 px) contre les segments route — ombres exactes derrière les
  * crêtes par construction ; 3 polygones plein-fan emboîtés, teinte chaude
  * unique (aucun découpage interne → aucune division visible ; pas de
  * hotspot transverse : son arc coupait le faisceau en deux), largeurs et
  * alphas étagées ≈ profil gaussien ; profondeur par nappe route + halo ;
  * atténuation physique `1/(1 + 0.6·d + 2.4·d²)` ; micro-tremblement de visée ; nappe lumineuse
  * suivant la chaussée sous l'empreinte ; 44 poussières advectées (vent
  * relatif + scintillement, clippées au polygone de visibilité : jamais
  * sous le sol) ; micro-flicker de lampe ; éteint sur épaves.
  * 2 roues : cercles dark `#1f2937` + jante unie `#9ca3af` + moyeu `#4b5563`
  * (pas de marqueur de rotation). Rayon random 14–24 px. Empattement (spacing) 55–95 px (distance entre centres des roues, symétrique ± autour du centre châssis, ancrage à −10px sous le châssis).
* Physique Rapier imposée :
  * Châssis : `RigidBodyDesc.dynamic().setTranslation(spawnX, spawnY).setAngvel(0).lockTranslations? NON` + `ColliderDesc.convexHull(vertices)` (fallback cuboid si hull échoue), `density 1.0`, `friction 0.6`, `restitution 0.05`, `ccdEnabled true`.
  * Roues : 2× `RigidBodyDesc.dynamic()` + `ColliderDesc.ball(radius)` `density 1.2`, `friction 1.5`, `restitution 0.1`, `frictionCombineRule Average`.
  * Liaisons : 2× `JointData.revolute(anchorChassis, anchorWheel)` pour la rotation + suspension : implémenter via 2× `JointData.prismatic(axisY, limits)` OU à défaut ressort manuel (appliquer chaque step une force `F = -k·Δ - c·v` sur l'axe vertical local). **Minimum V1 acceptable : revolute + ressort manuel + amortissement.** Suspension réglée généreuse mais saine : enfoncement statique ~9 px, amortissement `zeta ≈ 0.8` (la caisse vit sur les bosses sans rebondir ni racler).
  * Motorisation : couple franc (4.2e7 ≈ 1g) sur les 2 roues avec traction-control
  * à glissement limité (plein couple sous 60 px/s de glisse, décroissance douce
  * ensuite — jamais de frein actif ni coupure franche : monotone, stable).
  * Vitesse cible châssis 950 px/s, filet traînée 1050 (plein gaz = décollages
  * et flips : il faut doser les gaz). Antipatinage : friction élevée
  * (pneus 2.0 / route 1.5), pas de glisse savonneuse. Échelle moteur
  * `lengthUnit = 10` (Rapier plafonne les vélocités à 400·lengthUnit en dur).
  * Centre de masse légèrement bas (offset −4px) pour stabilité sans anti-retournement artificiel.
* API attendue `src/voiture.js` : `randomCarSpec(rng) → { bodyVerts, wheelRadius, wheelBase, color, bodyLen, bodyH }`, `createCar(world, spec, spawn) → { chassis, wheelF, wheelR, joints, spec, headlight }`, `destroyCar(world, car)`, `applyDrive(car, dir, dt)` avec `dir ∈ {−1,0,+1}`.
* Spawn : `(x=0, y=routeY(0) − 80px)`, angle 0, vélocité nulle. Zone plate garantit spawn stable.

### 3.4 Contrôles & lois physiques

* Clavier : `→ / D` = avancer, `← / A` = reculer, `R` = respawn manuel, `Espace` (optionnel) = frein fort. Support appui simultané = priorité au dernier. `dir=0` au relâchement ⇒ roue libre (pas de frein fantôme sauf frottements naturels).
* Mobile (navigateur téléphone) : joystick transparent en bas à droite (`data-testid="joystick"`), révélé au premier toucher ; glisser horizontal (zone morte 10 px, course ±38 px) : droite = avancer, gauche = reculer, relâcher = stop. Clavier prioritaire en cas d'usage simultané. Un seul doigt suivi.
* Gravité Rapier : `world.gravity = { x: 0, y: 980 }` (px/s², monde en px, équivalent 9.81·m avec 100px≈1m… utiliser `PX_PER_M=10` pour l'affichage uniquement, la physique reste en px).
* Fixed timestep : accumulateur à 120 Hz (`world.timestep = 1/120`, max 4 substeps/frame),
  `world.step()` avec `EventQueue` si besoin futur. Le 120 Hz divise par ~2 les
  impulsions discrètes par step (couple moteur, contacts) : à 60 Hz la voiture
  avançait par micro-saccades visibles en roulant (bruit ±30 % de la vitesse
  instantanée) ; à 120 Hz le défilement est lisse, pour un coût CPU négligeable
  (~10 corps dynamiques). Le rendu interpole entre les deux derniers états
  (`alpha = reste/STEP`) pour rester fluide sur écrans 60/120/144 Hz.
* Respect lois physiques : pas de téléportation (sauf respawn), pas de vélocité imposée directement (uniquement forces/couples/moteurs), collisions route↔roues↔châssis réelles, retournement possible sur bosses + excès de vitesse.

### 3.5 But, mort, pierre tombale, respawn

* **But :** aller le plus loin possible = maximiser `distance = max(0, (chassisX − spawnX) / PX_PER_M)` en mètres, 1 décimale. `best` = max session + persisté `localStorage['voituros.best']`.
* **Détection retournement :** `up = chassis.rotation()`, vecteur up local `(sin? à calculer via angle)`. `flipped = cos(angle) < cos(100°)` ≈ `cos(angle) < −0.17` (i.e. toit vers le bas à ±100°). Alternative robuste : produit scalaire upChâssis·upMonde < −0.17.
  * Tant que `flipped`, `flipTimer += dt`, HUD warning + compte à rebours. Si `!flipped`, `flipTimer = 0`.
  * Si `flipTimer > 3.0s` ⇒ mort.
* **Mort / pierre tombale :** la voiture morte devient fantôme : corps passés en `fixed` (ou `setEnabled(false)` pour la dynamique + teinte grise alpha 0.55), reste **sur place** aux coordonnées de la mort. Sous la voiture : label Pixi `Text "💀 123.4 m"` (blanc sur fond `#111827` alpha 0.8, font 14px monospace). Les tombes persistent après respawn (tableau `graves[]`, rendues en gris, non-collidantes après mort pour ne pas gêner — **colliders désactivés** `collider.setEnabled(false)` sauf visuel conservé).
* **Respawn :** après 1.2s (toast visible), nouveau `seed` voiture (`Math.random`), spawn au début `(0, routeY(0)−80)`, caméra snap au spawn, `flipTimer=0`, `distance` repart de 0 (best conservé). Le compteur de morts `deaths++` affiché.
* Cas limites : chute sous la route (y > routeY+500 ou y > 2000) = mort immédiate (tombstone à la projection x). Bloquage sans flip (vitesse ≈ 0 pendant 15s et distance < 5m) : afficher hint, pas de mort auto.

### 3.6 Caméra intelligente

* `src/camera.js` : `createCamera(app) → { update(dt, target, vel), snapTo(x,y) }`.
* Suivi : `camX = lerp(camX, carX + lookahead·velX, 1 − exp(−5·dt))`, `camY = lerp(camY, carY − 80, 1 − exp(−4·dt))`, `lookahead ≈ 0.35s` clampé ±180px.
* Zoom auto : `zoom = clamp(1.15 − speed·0.0006, 0.75, 1.15)` lissé. Monde → écran : `stage.pivot = (camX, camY)`, `stage.position = (w/2, h*0.55)`, `stage.scale = zoom`.
* Garde-fous : pas de NaN, clamp Y pour ne pas montrer le vide infini, resize handler.
* Exigence : à 600 px/s la voiture reste dans le viewport (marge ≥ 15%).

### 3.7 Thème & rendu

* Dark theme : fond `#0b0e14`, Voie lactée procédurale (bande inclinée 26°,
* plan galactique projeté en vraies coordonnées J2000 : Triangle d'été, Croix
* du Nord et ~10 étoiles brillantes à leurs positions exactes, Grand Rift avec
* extinction, ~400 étoiles ; dérive lente 3 px/s + parallaxe caméra 0.03,
* tuile 2048×1024 statique instanciée 3×3, zéro redraw). Route néon (cf. §3.2), voiture low-poly vive + phare jaune + faisceau. Tombes grises. Typo système/monospace. Pas d'images externes.
* Pixi 8 : `new PIXI.Application()`, `await app.init({ background, resizeTo: window })`, `app.ticker.add(loop)`. `Graphics` pour route/remblai/voiture (redraw châssis une fois, roues via `Graphics` repositionnés chaque frame — pas de recréation par frame).
* Sync visuel : chaque frame, `sprite.position.copyFrom(body.translation())`, `sprite.rotation = body.rotation()` (conversion px direct, Rapier2D-compat en unités monde = px ici).

## 4. Exigences non-fonctionnelles

* Perf : 60fps sur laptop standard, < 700 colliders route (600 segments OK), pas d'alloc par frame dans la boucle (réutiliser vecteurs).
* Robustesse : seed invalide ⇒ fallback `Date.now()%100000`, difficulté inconnue ⇒ Medium, WebGL indisponible ⇒ message DOM.
* Accessibilité : boutons focusables, `aria-label`, contraste ≥ 4.5:1 pour HUD texte.
* Code : ES modules, `src/main.js` < 300 lignes, logique découpée (`route.js`, `voiture.js`, `camera.js`, `game.js`, `utils.js`), JSDoc sur fonctions exportées, `bun run dev/build/preview` OK, `vite build` sans warning bloquant.

## 5. Architecture & fichiers imposés

```
/index.html            — #app, HUD DOM, <script type=module src=/src/main.js>
/vite.config.js        — server.port 5173, preview.port 4173
/src/main.js           — boot Pixi + Rapier.init(), boucle, câblage HUD/inputs
/src/game.js           — classe Game : état (ready|driving|flipped|dead), distance, best, graves, respawn
/src/route.js          — génération + colliders + rendu + routeYAt + DIFFICULTIES
/src/voiture.js        — randomCarSpec + createCar + applyDrive + sync meshes
/src/camera.js         — follow intelligent + zoom
/src/utils.js          — mulberry32, hashSeed, clamp, lerp, smoothstep
/src/style.css         — dark theme + HUD
/tests/e2e.spec.js     — Playwright (cf. §9)
/playwright.config.js  — webServer vite preview, baseURL
/PRD.md                — ce fichier
```

* États Game : `ready → driving ⇄ flipped (warning) → dead (1.2s) → ready (nouvelle voiture)`. `distance` mise à jour chaque frame, `best` en continu.
* Aucune erreur console en usage normal.

## 6. Données & persistance

* `localStorage['voituros.best']` (float m), `localStorage['voituros.difficulty']`, `localStorage['voituros.seed']`.
* URL params lus au boot : `?seed=123&difficulty=hard` (prioritaire sur storage). Changement difficulté ⇒ nouvelle route même seed numérique re-dérivé.

## 7. UX détaillée

* Boot : route tracée < 500ms, voiture posée au départ, caméra centrée, HUD `distance 0.0 m`, hint `◀ ▶ pour rouler` 4s.
* Roulage : distance live, caméra suit, phare éclaire l'avant, marqueurs 100m défilent.
* Flip : HUD warning rouge + `2.x s`, bip visuel (pas de son obligatoire), si redressement < 3s ⇒ reprise silencieuse.
* Mort : freeze 1.2s, toast `💀 123.4 m`, tombe posée, respawn avec nouvelle couleur/forme visiblement différente, toast `🚗 Nouvelle voiture !`.
* Difficulté : switch ⇒ toast `Nouvelle route Hard #seed`, tombes effacées, best conservé.

## 8. Critères d'acceptation (DoD)

1. `bun install && bun run build && bun run preview` OK, page sans erreur console.
2. Route continue 12000px, plate au départ, 3 difficultés visiblement croissantes (pente/amplitude).
3. Voiture = carrosserie polygonale + 1 phare avant + faisceau + 2 roues, random à chaque respawn (forme/couleur/rayon/empattement varient).
4. `→` avance, `←` recule (vérifié par x croissant/décroissant), physics Rapier réelle (chute, rebond, flip possibles).
5. Flip > 3s ⇒ mort + tombe avec `XX.X m` + respawn au début avec nouvelle voiture.
6. Caméra suit en x et y avec lookahead + zoom, voiture toujours visible à vitesse max.
7. HUD distance/best/difficulté/seed/warning fonctionnels + `data-testid` présents.
8. Playwright : tous les tests §9 verts, screenshots analysés (route, voiture, tombe, caméra).

## 9. Plan de test Playwright (imposé)

* `playwright.config.js` : `testDir: ./tests`, `use.baseURL: http://127.0.0.1:4173`, `webServer: { command: 'npm run preview -- --port 4173 --strictPort', port: 4173, reuseExistingServer: true }`, 1 worker CI, screenshots `only-on-failure` + captures explicites par test.
* `data-testid` requis : `hud-distance`, `hud-best`, `hud-deaths`, `btn-easy`, `btn-medium`, `btn-hard`, `btn-new-route`, `btn-restart`, `hud-seed`, `flip-warning`, `toast`, `game-canvas` (le canvas), `joystick` (tactile).
* Scénarios `tests/e2e.spec.js` :
  1. `boot` — canvas visible, `hud-distance` = `0.0 m`, pas d'erreur console, screenshot `boot.png`.
  2. `drive-forward` — `keyboard.down('ArrowRight')` 3s ⇒ `distance > 5 m`, screenshot `drive.png`. Analyse : voiture déplacée vers +X, caméra a suivi (comparer `window.__VOITUROS__.carX` avant/après + screenshot non-plat).
  3. `drive-backward` — restart, `ArrowLeft` 2s ⇒ x diminue ou reste < spawn+5m (pas de marche avant fantôme).
  4. `difficulty-switch` — clic Hard ⇒ `hud-seed` change ou route regenerée (`window.__VOITUROS__.difficulty === 'hard'`), screenshot `hard.png` (pentes visiblement plus fortes que `easy.png`).
  5. `flip-death-tombstone` — hook debug `window.__VOITUROS__.debugFlip()` (retourne la voiture, à exposer par le jeu UNIQUEMENT pour les tests) ⇒ `flip-warning` visible, attendre 3.5s ⇒ `toast` contient `m`, `deaths === 1`, tombe rendue (`__VOITUROS__.graves.length === 1`), screenshot `tombstone.png`.
  6. `respawn-new-car` — après mort, attendre 2s ⇒ `distance` repart ~0, `carSpec` différent (couleur/verts), caméra revenue au départ.
  7. `camera-follow` — rouler 5s ⇒ `|carScreenX − viewportCenterX| < 40% viewport` (via `__VOITUROS__.screenInfo()`), screenshot `camera.png`.
* Hooks debug exposés : `window.__VOITUROS__ = { carX(), difficulty, graves, deaths, distance, carSpec, screenInfo(), debugFlip(), teleport(x), reset() }`. Interdits en prod hors tests ? Tolérés, préfixés `debug`, documentés.
* Validation screenshots : analyser visuellement (route néon sur fond dark, voiture low-poly + phare, tombe `💀 XX m`, HUD lisible). Si écart ⇒ corriger et relancer.

## 10. Risques & mitigations

* Instabilité suspensions Rapier ⇒ fallback ressort manuel + ccd + clamp vélocité.
* Perf 600 colliders ⇒ segments fixes, pas de contact events inutiles, `Graphics` static.
* Pentes Hard infranchissables ⇒ écrêtage pente + tests drive-forward sur les 3 difficultés (doit progresser > 5m en 5s en Hard avec vitesse maintenue).
* Flakiness Playwright ⇒ `webServer.reuseExistingServer`, attentes sur `data-testid`, `toPass` pour distance.

## 11. Roadmap

* V1 (ce PRD) : solo local, 3 difficultés, tombes, best local.
* V2 : multi-local (2–4 joueurs, 1 voiture/player, caméras split ou follow leader + fantômes), seeds partageables via URL, leaderboard local.
* V3 : mobile tactile, son moteur WebAudio, mode nuit/phare fort.

---

## 12. Versions gelées (vérifiées le 2026-09-04 via `npm view`)

* `pixi.js@8.20.1`, `@dimforge/rapier2d-compat@0.20.0` (compat = WASM inline, `await RAPIER.init()` obligatoire), `vite@8.2.2`, `@playwright/test@1.62.1`, Node v26.8.1.
* Pas de `rapier2d` natif (pas de WASM bundling complexe) — utiliser **compat** uniquement.

## 13. Ordre de dev conseillé

1. `utils.js` + `route.js` (génération déterministe + test visuel).
2. `voiture.js` (spawn statique sur plat, puis suspensions + drive).
3. `camera.js` + `game.js` (états, flip 3s, tombe, respawn).
4. `main.js` + HUD + `style.css` + hooks `__VOITUROS__`.
5. `playwright.config.js` + `tests/e2e.spec.js`, itérer jusqu'au vert + screenshots validés.
