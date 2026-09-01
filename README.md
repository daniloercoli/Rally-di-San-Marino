# Rally San Marino

![Icona di Rally San Marino](public/favicon.png)

Rally San Marino è un gioco di rally multiplayer che si apre nel browser. Usa la rete
stradale reale di San Marino e permette a un massimo di quattro persone di giocare insieme
da computer collegati alla stessa rete locale.

## Cosa serve

- un computer Windows, macOS o Linux;
- [Node.js](https://nodejs.org/) versione 20 o successiva (versione 24 consigliata);
- una connessione a Internet per la prima installazione;
- un browser recente, come Chrome, Edge, Firefox o Safari.

`npm` è già incluso con Node.js: non va installato separatamente.

## Prima esecuzione

1. Da GitHub, premere **Code** e poi **Download ZIP**.
2. Estrarre lo ZIP e aprire PowerShell o il Terminale dentro la cartella del progetto.
3. Copiare ed eseguire, una riga alla volta:

```bash
npm ci
npm run build
npm start
```

Il primo comando scarica i componenti necessari e può richiedere qualche minuto. Quando
il server è partito, lasciare aperta la finestra del terminale e visitare:

**http://localhost:3100**

Per gli avvii successivi basta eseguire `npm start`. Dopo aver scaricato una nuova versione
del progetto, ripetere tutti e tre i comandi.

## Giocare dalla rete interna dell'ufficio

Gli altri computer non devono installare il progetto: basta che siano collegati alla stessa
rete Wi-Fi o via cavo del computer che lo esegue.

1. Trovare l'indirizzo IP locale del computer principale nelle impostazioni di rete. Di
   solito assomiglia a `192.168.1.25` o `10.0.0.25`.
2. Lasciare attivi `npm start` e il computer principale.
3. Sugli altri computer, aprire nel browser `http://IP_DEL_COMPUTER:3100`, per esempio
   `http://192.168.1.25:3100`.
4. Se il sistema mostra una richiesta del firewall, consentire Node.js sulla **rete privata**.

Se la pagina non si apre, controllare che tutti i dispositivi siano sulla stessa rete e che
il firewall permetta la porta `3100`. Questa configurazione è pensata per una rete locale
fidata: non esporre direttamente il gioco su Internet.

## Come si gioca

- Premere **Entra nella lobby**, scegliere nome e colore e premere di nuovo lo stesso
  pulsante per entrare.
- Il primo giocatore è l'host e può scegliere il percorso.
- Tutti premono **Sono pronto**; poi l'host avvia la gara.
- Usare `WASD` o le frecce per guidare e la barra spaziatrice per il freno a mano.

Per fermare il gioco, tornare al terminale e premere `Ctrl+C`.

La mappa usa dati **© OpenStreetMap contributors**, disponibili con licenza
[ODbL](https://www.openstreetmap.org/copyright).
