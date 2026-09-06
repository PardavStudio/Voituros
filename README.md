# 🚗 Voituros — roule loin, meurs avec style

![VOITUROS — titre de glace sur le lac gelé](screenshots/title.png)

**Voituros** est un petit jeu de conduite 2D à la physique délicieusement nerveuse : pilote une voiture low-poly à la peinture unique sur un lac gelé qui serpente sous une vraie Voie lactée, va le plus loin possible… et évite de finir sur le toit.

## ✨ Pourquoi tu vas aimer

- **Physique crédible qui se ressent** — moteur Rapier 2D à 120 Hz, suspensions à butées, patinage, transferts de charge, sauts et flips : chaque bosse se négocie au doigté.
- **Un vrai son de V8** — moteur Greenwood extrait de GTA San Andreas (paires accel/decel + ralenti), vraie boîte auto 4 rapports (rupteur, kickdown, rétrogradages), micro-coupures d'allumage. 🔊 cliquer une fois pour activer le son.
- **Peinture unique à chaque voiture** — uni, bi-ton, bandes racing ou bas de caisse, teintes harmonieuses, reflet environnement (ciel/sol, nacre, point chaud, strie soleil qui glisse avec le tangage), jantes alliage 5 branches assorties. Zéro contour.
- **Un lac gelé vivant** — dalle de glace (fissures, bulles d'air, cristaux dendritiques, étincelles), neige réaliste (3 profondeurs, rafales, éclairée par le phare), phare raycasté en temps réel (56 rayons, ombres exactes derrière les crêtes, poussières en suspension, micro-flicker).
- **Une vraie Voie lactée** — plan galactique projeté en coordonnées J2000 réelles : Triangle d'été, Croix du Nord et étoiles brillantes à leurs positions exactes, Grand Rift, dérive lente + parallaxe.
- **Rejouabilité infinie** — route procédurale seedée + voiture et peinture aléatoires à chaque respawn, 3 difficultés (Easy / Medium / Hard).
- **Mort stylish** — retourné plus de 3 s ? Pierre tombale `💀 XX.X m` sur place, best score persisté, nouvelle voiture, on repart.
- **Mobile first-friendly** — joystick tactile transparent en bas à droite sur téléphone.

![En pleine action — phare, neige et glace](screenshots/drive.png)

## 🎮 Contrôles

| Action | Clavier | Mobile |
|---|---|---|
| Avancer | `→` / `D` | Glisser le joystick à droite |
| Reculer | `←` / `A` | Glisser le joystick à gauche |
| Recommencer | `R` | Bouton Recommencer |
| Frein fort | `Espace` | — |
| Son moteur | `M` ou bouton 🔊 | Bouton 🔊 |

![Joystick tactile sur mobile](screenshots/mobile-joystick.png)

> Astuce : plein gaz, ça décolle — et ce qui décolle finit souvent sur le toit. Dose. 😏

## 🏁 Difficultés

| | Easy | Medium | Hard |
|---|---|---|---|
| Relief | vallonné doux (≤ 20°) | bosses franches (≤ 35°) | murs à 50° |

![Ça se corse en Hard](screenshots/hard.png)

## 🚀 Démarrage rapide

Prérequis : **[Bun](https://bun.sh) ≥ 1.0** (runtime + install ; les tests
Playwright tournent eux sous Node, déjà requis par Playwright lui-même).

```bash
bun install
bun run dev      # → http://localhost:5173
```

```bash
bun run build    # build de prod
bun run preview  # → http://127.0.0.1:4173
bun run test     # suite Playwright sous Node (9 tests, vrai Chromium)
```

> Note : les tests tournent dans Docker en root ; si des fichiers
> `root` apparaissent (`dist/`, `screenshots/`) : `sudo chown -R $USER .`

Astuce : `?seed=123&difficulty=hard` dans l'URL pour rejouer (ou partager) une route exacte.

![Retourné ! Tombe posée, on respawn avec une nouvelle voiture](screenshots/tombstone.png)

## 🛠️ Sous le capot

- **Rendu** `pixi.js@8` (canvas fullscreen, DPR ≤ 2) · **Physique** `@dimforge/rapier2d-compat` (monde en px, pas fixe 120 Hz + interpolation de rendu, `lengthUnit = 10`) · **Build** `vite` · **Tests** `@playwright/test` (e2e + fluidité + mobile, via Docker).
- Code découpé en modules ES documentés : `src/route.js` (génération seedée + lissage de courbure), `src/glace.js` (dalle, fissures, cristaux, scintillements), `src/neige.js` (chute écran, vent apparent), `src/voiture.js` (spec aléatoire, suspension, traction-control à glissement limité, éclairage raycasté), `src/peinture.js` (peinture procédurale + reflet, sans contour), `src/engine.js` (son Greenwood, boîte auto 4 rapports), `src/sky.js` (Voie lactée), `src/camera.js` (suivi + lookahead + zoom auto), `src/game.js` (états, tombes, scores).
- Zéro asset externe (hors samples moteur extraits de GTA SA pour usage personnel), zéro alloc par frame dans les boucles chaudes.

Le détail de la spec : voir [`PRD.md`](PRD.md).
