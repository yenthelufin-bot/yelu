# Location Scout

Vindt fotoshootlocaties voor je, zodat je niet uren door Google Maps en Street View hoeft te scrollen. **Gratis te gebruiken.**

Je geeft een gemeente of stad op, met een straal in km. Je kiest het soort plek, de kleursetting en eventueel extra wensen. Location Scout zoekt dan kandidaat-plekken en Claude bekijkt elke plek in Street View. Je krijgt een gerangschikte lijst terug met:

- een score van 0 tot 100 en een korte beschrijving van de plek als shootlocatie;
- sterke punten en aandachtspunten (hekken, verkeer, rommel, …);
- het kleurpalet van de plek en hoe goed het past bij je gevraagde kleuren;
- lichtadvies: wanneer de zon goed staat voor de beste kijkrichting;
- de Street View-beelden, een 360°-weergave, en links naar Street View en een route.

Markeer favorieten, wijs plekken af en schrijf notities (bv. "toestemming vragen"). Exporteer daarna naar **KML** (Google My Maps, Google Earth), **GPX** (gps, Komoot) of **CSV** (Excel). Elke zoektocht wordt bewaard.

## Waarom het gratis is

- **Claude** bekijkt de beelden in de **Claude desktop-app**, binnen je eigen abonnement. Location Scout koppelt zich daaraan als hulpmiddel (een "MCP-server"), dus er is geen betaalde API-sleutel nodig. Het telt wel mee voor de gebruikslimieten van je abonnement. Een zoektocht van 20 plekken is ongeveer één flink gesprek.
- **Google** geeft elke maand een gratis hoeveelheid per dienst: 10.000 Street View-beelden, 10.000 keer een plaats opzoeken en 5.000 Places-zoekopdrachten. Het controleren of er Street View is en de 360°-weergave zijn altijd gratis. Location Scout houdt bij hoeveel je deze maand gebruikt hebt en **stopt vóór die grens**, met een kleine marge. Je betaalt dus niets, ook al vraagt Google bij het aanmaken van de sleutel een bankkaart.
- Een zoektocht van 20 plekken gebruikt zo'n 80 Street View-beelden. Daarmee kun je ruim 100 zoektochten per maand doen.
- **OpenStreetMap** is volledig gratis.

## Hoe het zoekt

1. **Kandidaten verzamelen** uit drie bronnen:
   - **Google Places**: benoemde plekken die bij je type passen (fabrieken, kastelen, havens, …) en je eigen omschrijving.
   - **OpenStreetMap**: plekken die Google niet als "plaats" kent, zoals industriegebieden, ruïnes, leegstaande gebouwen, silo's, bruggen en bossen.
   - **Steekproef**: gelijk verspreide punten over de hele zone. Zo vind je ook gewone straten en landwegen die nergens een naam hebben.
2. **Street View-dekking controleren** (gratis) en de plekken met een panorama houden.
3. **Claude bekijkt** per plek 3 à 4 kijkrichtingen en geeft een score, palet en uitleg.
4. De resultaten verschijnen op de **resultatenpagina** in je browser.

## Installatie

Drie stappen. De tweede doet de rest automatisch.

### 1. Node.js

Installeer [Node.js](https://nodejs.org) **22.18 of nieuwer** (kies "LTS"), en de [Claude desktop-app](https://claude.ai/download) als je die nog niet hebt.

### 2. Google-sleutel aanmaken

In de [Google Cloud Console](https://console.cloud.google.com/):

1. Maak een project aan en koppel een facturatieaccount. Google vraagt een bankkaart, maar Location Scout blijft binnen het gratis gebruik.
2. Zet onder *APIs & Services → Library* deze vier API's aan: **Geocoding API**, **Places API (New)**, **Street View Static API** en **Maps Embed API**.
3. Maak onder *Credentials* een **API-sleutel**. Beperk ze via *API restrictions* tot die vier API's.

Wil je extra zekerheid? Zet in Google Cloud onder *Billing → Budgets* een budgetwaarschuwing van € 1.

### 3. Setup draaien

Open een terminal (Mac: *Terminal*, Windows: *PowerShell*) in de map `scout` en typ:

```bash
npm run setup
```

De setup:
- controleert je Node-versie;
- installeert de onderdelen;
- vraagt je Google-sleutel, bewaart die in `scout/.env` en test of hij werkt;
- koppelt Location Scout aan de Claude desktop-app. Je bestaande instellingen blijven behouden en de oude versie wordt bewaard als `.backup`.

Sluit daarna de Claude desktop-app **volledig** af en open ze opnieuw. In een nieuw gesprek staat Location Scout dan bij je tools/connectors.

Gebruik je Claude Code in deze repo? Dan is de koppeling al ingesteld in `.mcp.json`.

<details>
<summary>Liever met de hand koppelen?</summary>

Open in de Claude desktop-app **Instellingen → Developer → Edit Config** en voeg dit toe, met het volledige pad naar deze map:

```json
{
  "mcpServers": {
    "location-scout": {
      "command": "node",
      "args": ["/volledig/pad/naar/yelu/scout/src/mcp.ts"]
    }
  }
}
```

Zet je sleutel dan zelf in `scout/.env` (kopieer `.env.example`) en voer `npm install` uit in de map `scout`.
</details>

## Gebruiken

**Rechtstreeks in Claude.** Typ in de Claude-app bijvoorbeeld:

> Zoek industriële locaties aan het water rond Gent, 10 km, in roest- en staaltinten, voor een modeshoot. Weinig mensen in beeld.

Claude zoekt de plekken, bekijkt ze één voor één en geeft je de beste met een link naar de resultatenpagina.

**Via de resultatenpagina.** Zolang de Claude-app draait, staat die pagina op **http://localhost:4173**. Daar stel je je zoektocht in met knoppen en een kaart, en klik je op **Kopieer opdracht voor Claude**. Plak de opdracht in de Claude-app. De pagina toont live hoe Claude vordert. Onder *Eerdere zoektochten* vind je alles terug.

Wil je de resultatenpagina zonder de Claude-app openen? Typ dan `npm start` in de map `scout/`.

## Tips

- **Combineer types**, bijvoorbeeld *Industrieel* + *Water*, voor een silo aan het kanaal.
- **Beschrijf in eigen woorden** wat je zoekt, bijvoorbeeld "lange rechte weg met bomenrij" of "roestige loods met grote schuifdeur".
- **Kleur**: kies presets of voeg je eigen kleuren toe (bv. uit een moodboard).
- **Beeld niet ouder dan …** sluit verouderde Street View-beelden uit.
- Begin met **20 plekken**. Dat past goed in één gesprek. Wil je meer, doe dan een tweede zoektocht met een andere straal of andere types.

## Goed om te weten

- Street View toont de plek vanaf de openbare weg. De score zegt iets over hoe de plek eruitziet, niet of je er mag fotograferen. Vraag bij privéterrein altijd toestemming.
- Het lichtadvies is een vuistregel op basis van de kijkrichting, voor België en Nederland.
- De Street View-beelden worden alleen in het geheugen gehouden zolang de app draait; zo vragen de voorwaarden van Google het. Bij een oudere zoektocht zie je in de plaats daarvan de live 360°-weergave.
- Zoektochten en de maandteller staan in `scout/data/`.

## Optioneel: zonder Claude-app, via de Claude API (betaald)

Zet je `ANTHROPIC_API_KEY` in `.env`, dan verschijnt op de resultatenpagina een knop **Start hier**. Daarmee loopt de hele zoektocht op de pagina zelf, zonder Claude-app. Dat kost wel geld per gebruik: ongeveer $0,03 à $0,05 per plek. Google blijft ook dan binnen het gratis gebruik.

## Ontwikkelen

```bash
npm test           # tests, zonder sleutels of netwerk
npm run typecheck  # TypeScript-controle
```

De code is TypeScript en draait rechtstreeks met Node, zonder bouwstap:

- `src/mcp.ts`: de koppeling met de Claude-app
- `src/pipeline.ts`: het zoekproces
- `src/usage.ts`: de bewaking van het gratis Google-gebruik
- `src/presets.ts`: types, kleuren en extra wensen. Hier voeg je eenvoudig een nieuw type locatie toe.
- `src/server.ts` + `public/`: de resultatenpagina
