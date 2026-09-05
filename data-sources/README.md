# Sorgente elevation

`elevation-raw.json` è un file generato e versionato: non modificarlo o formattarlo
a mano. Contiene il checkpoint grid v1 completo, associato all'hash di `roads.json`,
con 20.216 quote originali in metri e provenienza del recupero/completamento.

- Indici `[0, 16825)`: recuperati senza modifiche dal checkpoint storico indicato
  in `provenance.recovered`, con revisione Git e SHA-256. Il provider storico dei
  singoli batch non era registrato.
- Indici `[16825, 20216)`: scaricati da Open-Meteo il 3 settembre 2026 in 34 batch;
  `provenance.downloaded` conserva intervalli esclusivi, provider e timestamp UTC.

I nuovi dati provengono da [Open-Meteo / Copernicus DEM GLO-90](https://open-meteo.com/en/docs/elevation-api).
Per attribuzione e limiti del recupero storico consultare la
[guida tecnica](../docs/README.md#dataset-versionati).

Rigenerazione offline riproducibile del runtime pubblico:

```bash
npm run rebuild:elevation
```

Il comando conserva tutte le quote esattamente, senza maschere stradali, medie sottratte,
clamp, offset o moltiplicatori. Questa cartella non è servita dal gioco e non fa parte
del bundle frontend. Dettagli e verifiche: [ELEV-07](../docs/qa/elev-07-2026-09-03.md).
