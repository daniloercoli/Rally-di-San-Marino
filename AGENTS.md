# AGENTS.md

Queste istruzioni valgono per l'intero repository.

## Obiettivo del progetto

`rally-san-marino` è un gioco di rally multiplayer nel browser. Il server Node.js è
autoritativo per fisica, avanzamento, classifica e tempi; il client Three.js renderizza
la mappa di San Marino ricavata da OpenStreetMap e interpola gli snapshot ricevuti via
Socket.IO.

Il piano di lavoro corrente è in `docs/TODO.md`. Prima di modificare il codice, scegliere un
solo task con tutte le sue dipendenze completate. Non includere refactoring o feature non
richiesti dal task.

`README.md` è la guida pubblica essenziale per installazione e avvio. `docs/README.md` è
la guida tecnica per collaboratori, produzione, provenienza dei dataset e procedura
elevation. Quando un comando o un requisito cambia, mantenerli coerenti con `package.json`,
CI e queste guide.

## Prima di iniziare

1. Leggere per intero il task scelto in `docs/TODO.md`, inclusi dipendenze, criteri di
   accettazione e verifiche.
2. Eseguire `git status --short` e preservare tutte le modifiche preesistenti dell'utente.
3. Leggere tutti i file indicati dal task e i relativi test prima di editarli.
4. Se `node_modules/` manca o il lockfile è cambiato, installare una sola volta nel
   worktree con `npm ci`; non usare `npm install` salvo modifica intenzionale delle
   dipendenze. Agenti che condividono lo stesso worktree non devono eseguire installazioni
   concorrenti.
5. Riprodurre il difetto o aggiungere un test di caratterizzazione quando il task riguarda
   un bug.

Non marcare un task come completato se una verifica obbligatoria non è stata eseguita o
passa solo per caso. Registrare nel TODO l'evidenza minima e l'eventuale limite ambientale.

## Mappa del repository

- `README.md`: presentazione pubblica e istruzioni essenziali per l'avvio locale/LAN.
- `docs/README.md`: guida tecnica, operativa e sulla provenienza dei dataset.
- `docs/TODO.md`: piano di lavoro corrente con dipendenze, criteri ed evidenze.
- `server.js`: Express, Socket.IO e simulazione autoritativa a intervalli di 50 ms con
  sotto-step deterministici ad alta velocità.
- `public/index.html`: shell HTML, HUD e schermata di ingresso.
- `public/src/main.js`: client Three.js, rete, input, audio, UI, minimappa e mondo 3D.
- `public/src/car-model.js`: modello Three.js dimensionato della vettura, isolato e
  verificabile senza avviare il browser.
- `public/src/input-state.js`, `player-identity.js` e `route-lobby.js`: helper puri per
  comandi tastiera, identità iniziale e catalogo tracciati ricevuto dalla lobby.
- `public/src/start-lights.js`: validazione e fallback deterministico del semaforo client.
- `public/src/qa-metrics.js`: contatori read-only per il collaudo browser di renderer e
  trasformazioni della scena.
- `public/src/road-geometry.js`: geometrie stradali e tratteggi aggregate in due batch
  renderizzabili, verificabili anche senza DOM/WebGL.
- `public/src/world-data.js`: validazione JSON world lato browser, interpolazione elevation
  e preparazione sicura delle geometrie senza dipendenze DOM/WebGL.
- `shared/mapdata.js`: parsing Overpass, classi stradali e proiezione geografica.
- `shared/geometry.js`: primitive geometriche e indice spaziale delle strade.
- `shared/physics.js`: fisica arcade, superfici, drivetrain e collisioni fra auto.
- `shared/route.js`: grafo stradale, A*, resampling e scelta del percorso.
- `shared/elevation.js`: griglia elevation v1, validatori di checkpoint, asset runtime e
  sorgente legacy; conversione legacy (logica pura, nessuna I/O).
- `scripts/elevation-store.js`: hash SHA-256, scrittura atomica (temp+rename) e
  conversione legacy del partial elevation su directory arbitrarie.
- `scripts/test-server.js`: suite unit/integration del server.
- `scripts/test-production.js`: smoke test dell'artefatto production su directory fixture.
- `scripts/test-elevation.js`: suite offline (zero rete) di griglia, checkpoint e asset
  elevation.
- `scripts/fetch-*.js` e `scripts/overpass-*.ql`: acquisizione dei dati geografici.
- `scripts/validate-map.js`: diagnostica della mappa; stampa statistiche ma non è, da solo,
  un quality gate assertivo.
- `scripts/validate-world.js`: quality gate assertivo e offline per roads, buildings,
  elevation runtime e checkpoint/partial legacy.
- `public/data/`: dataset geografici versionati e voluminosi.
- `public/favicon.png`: icona raster del gioco usata nel tab del browser.
- `vite.config.js`: frontend con root `public/`, alias `shared` e proxy Socket.IO.
- `dist/` e `node_modules/`: output generati e ignorati; non modificarli manualmente.

## Invarianti architetturali

- Conservare i moduli ESM e le estensioni `.js` negli import locali.
- `shared/` viene eseguito sia da Node.js sia dal bundle browser. Non introdurre in questi
  moduli API disponibili soltanto in uno dei due ambienti.
- Il server resta la fonte di verità per posizione, velocità, RPM, marcia, frenata, freno
  a mano, tracciato scelto dall'host, checkpoint, ranking, stato della gara, semaforo e
  tempo. Il client non deve poter imporre questi valori.
- Ogni modifica al protocollo Socket.IO deve essere coordinata in `server.js`,
  `public/src/main.js` e nei test di integrazione.
- Considerare ogni payload Socket.IO non attendibile: normalizzare il contenitore,
  validare tipi e limiti e usare fallback deterministici.
- Non inserire valori provenienti dalla rete in HTML costruito come stringa. Preferire
  `textContent`, proprietà DOM e valori già validati.
- I checkpoint del percorso sono ordinati; una vettura avanza soltanto raggiungendo il
  checkpoint successivo.

### Coordinate e unità

- `x`: asse est/ovest in metri.
- `z`: asse nord/sud in metri, con latitudine invertita dalla proiezione.
- `y`: quota del rendering.
- `yaw = 0` punta verso `-z`; il vettore avanti è
  `(Math.sin(yaw), -Math.cos(yaw))`.
- Velocità e parametri fisici sono in m/s; l'HUD converte in km/h con `* 3.6`.
- `dt` è espresso in secondi; tempi di gara e timestamp sono in millisecondi.

## Setup e comandi

Il repository dichiara Node `>=20` in `engines` e usa la major 24 in `.nvmrc` e CI; serve
inoltre una runtime dotata di `fetch` e `AbortSignal.timeout`. La baseline del 2026-08-28
è stata verificata con Node 24.7.0 e npm 11.5.1.

```bash
npm ci
npm run dev
```

`npm run dev` avvia:

- backend Socket.IO su `http://localhost:3100`;
- frontend Vite su `http://localhost:5173`.

Aprire la porta 5173 durante lo sviluppo. Il proxy Vite punta per default alla porta 3100;
fixture isolate possono impostare `RALLY_BACKEND_URL` senza modificare la configurazione.
Non cambiare `PORT` durante `npm run dev` senza coordinare anche il target del proxy.

Comandi di verifica disponibili:

```bash
npm test
npm run check:syntax
npm run test:server
npm run test:elevation
npm run test:world
npm run test:ci
npm run build
node scripts/validate-map.js
npm run validate:world
```

`npm run fetch-elevation:slow` riprende un eventuale checkpoint elevation con batch da 25
e una pausa di 300.000 ms fra richieste. Sul dataset completo esce 0 senza rete; una
rigenerazione richiede `--force`, resta un'operazione manuale di lunga durata e richiede
autorizzazione esplicita alla rete. Non fa parte dei quality gate automatici.

`npm test` esegue le suite `test:server`, `test:elevation`, `test:world` e `test:ci`, poi
crea il bundle ed esegue `test:production`; passa quindi anche da un checkout privo di
`dist/`. `npm run check:syntax` applica `node --check` a tutti i sorgenti JavaScript.
`npm run test:elevation` è offline (zero rete) e opera solo su directory temporanee.
`npm run test:world` e `npm run validate:world` sono offline e non modificano i dataset.
Il workflow `.github/workflows/ci.yml` usa Node 24 e `npm ci` e non esegue fetch geografici.

`npm run test:server` apre porte locali effimere e in alcuni sandbox richiede
autorizzazione. Non scambiare un errore `listen EPERM` per un fallimento applicativo.

`npm start` (production) serve il bundle da `dist/` e termina subito con exit non zero se
manca `dist/index.html`, `roads.json` o `buildings.json`. `node server.js --dev` e
`npm run dev` servono `public/` per lo sviluppo.

## Matrice minima di verifica

- Modifiche a `shared/`, `server.js` o al protocollo: syntax check dei file toccati,
  `npm run test:server` e `npm run build`.
- Modifiche frontend/rendering/UI/audio: `npm run build` più smoke test su 5173 con console
  pulita; se coinvolgono multiplayer, usare almeno due schede/browser.
- Modifiche a mappa, route o parser: aggiungere `node scripts/validate-map.js` e controlli
  assertivi pertinenti.
- Modifiche alla pipeline world/elevation: usare soltanto fixture e mock nei test; eseguire
  `npm run test:elevation` e `npm run validate:world` prima di qualsiasi download reale.
- Modifiche al percorso production: verificare HTML, asset JS, `/data/roads.json`,
  `/data/buildings.json` e connessione Socket.IO dalla stessa origine.

Il solo esito positivo della build non sostituisce uno smoke test browser per codice
Three.js, DOM o Socket.IO.

## Guardrail sui dati

I seguenti file sono generati, versionati e non devono essere editati o formattati a mano:

- `public/data/roads.json` (circa 3,2 MiB);
- `public/data/buildings.json` (circa 4,2 MiB);
- `public/data/elevation.json` (grid v1 completo con 20.216 valori).

La baseline completata contiene `elevation.json`; `.elevation-checkpoint.json` e
`.elevation-part.json` devono restare assenti da `public/data/`. Il partial storico con
6.100 valori è conservato soltanto in `scripts/fixtures/elevation-legacy-6100.json` per i
test offline. Non eseguire nessuno dei comandi seguenti salvo richiesta esplicita del task
e autorizzazione alla rete:

```bash
npm run fetch-map
npm run fetch-buildings
npm run fetch-elevation
npm run fetch-world
```

Questi comandi contattano servizi esterni, possono durare a lungo, subire rate limiting e
sovrascrivere dataset tracciati. In particolare:

- non rigenerare `roads.json` mentre esiste un partial elevation senza invalidarlo o
  migrarlo esplicitamente;
- non avviare il fetch elevation finché `ELEV-01`--`ELEV-04` non sono completati;
- non pubblicare `.elevation-part.json` in `dist/`;
- non aggiungere a Git `dist/`, `node_modules/` o file `*.log`;
- modificare `package-lock.json` soltanto insieme a una variazione intenzionale delle
  dipendenze.

## Stile e struttura delle modifiche

- Usare 2 spazi, apici singoli e semicolon, coerentemente con il codice esistente.
- Mantenere in italiano i testi visibili all'utente, salvo requisito contrario.
- Preferire funzioni pure e moduli piccoli per nuova logica testabile. Non ampliare il
  monolite `public/src/main.js` se il task prevede già un'estrazione mirata.
- Evitare dipendenze nuove quando le API standard bastano; se una dipendenza è necessaria,
  motivarla e aggiornare lockfile e documentazione nello stesso task.
- Non cambiare tuning fisico, grafica, protocollo e lifecycle nello stesso intervento se il
  task non lo richiede.
- Non silenziare errori inattesi. Distinguere esplicitamente asset opzionali assenti da JSON
  corrotto o schema incompatibile.
- Non ottimizzare senza una misura iniziale e una misura successiva comparabile.

## Definition of Done di un task

Un task è concluso solo quando:

1. la modifica resta nel perimetro dichiarato;
2. i criteri di accettazione del TODO sono soddisfatti;
3. i test pertinenti includono almeno un caso che falliva prima della correzione;
4. i comandi obbligatori sono passati, oppure il limite ambientale è documentato senza
   dichiarare successo;
5. `git diff --check` non segnala errori e il diff non contiene output generati o modifiche
   estranee;
6. `docs/TODO.md` e `AGENTS.md` vengono aggiornati soltanto se stato, comandi o invarianti
   sono realmente cambiati.
