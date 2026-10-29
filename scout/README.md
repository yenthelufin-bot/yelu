# Frame Finder

Vindt fotoshootlocaties voor je, zodat je niet uren door Google Maps en Street View hoeft te scrollen. **Gratis te gebruiken.**

*(Voorheen Location Scout. De startbestanden heten nog zo.)*

Je geeft een gemeente of stad op, met een straal in km. Je kiest het soort plek, de kleursetting en eventueel extra wensen. Location Scout zoekt dan kandidaat-plekken, bekijkt elke plek in Street View en laat de foto's beoordelen door Google Gemini. Alles gebeurt in je browser. Je krijgt een gerangschikte lijst terug met:

- een score van 0 tot 100 en een korte beschrijving van de plek als shootlocatie;
- sterke punten en aandachtspunten (hekken, verkeer, rommel, …);
- het kleurpalet van de plek en hoe goed het past bij je gevraagde kleuren;
- lichtadvies: wanneer de zon goed staat voor de beste kijkrichting;
- de Street View-beelden, een 360°-weergave, en links naar Street View en een route.

Markeer favorieten, wijs plekken af en schrijf notities (bv. "toestemming vragen"). Exporteer daarna naar **KML** (Google My Maps, Google Earth), **GPX** (gps, Komoot) of **CSV** (Excel). Elke zoektocht wordt bewaard.

## Waarom het gratis is

- **Gemini** beoordeelt de foto's met de **gratis versie** van Google. Die heeft een limiet per minuut en per dag; Location Scout wacht vanzelf als Google dat vraagt en stopt netjes bij de daglimiet (die gaat rond 9 uur Belgische tijd opnieuw open). Je actuele limieten zie je in [Google AI Studio](https://aistudio.google.com) bij *Usage*. Let op: Google mag gratis gebruik inzetten om zijn modellen te verbeteren.
- **Google** geeft elke maand een gratis hoeveelheid per dienst: 10.000 Street View-beelden, 10.000 keer een plaats opzoeken en 5.000 Places-zoekopdrachten. Het controleren of er Street View is en de 360°-weergave zijn altijd gratis. Location Scout houdt bij hoeveel je deze maand gebruikt hebt en **stopt vóór die grens**, met een kleine marge. Je betaalt dus niets, ook al vraagt Google bij het aanmaken van de sleutel een bankkaart.
- Een zoektocht van 20 plekken gebruikt zo'n 80 Street View-beelden. Daarmee kun je ruim 100 zoektochten per maand doen.
- **OpenStreetMap** is volledig gratis.

## Hoe het zoekt

1. **Kandidaten verzamelen** uit drie bronnen:
   - **Google Places**: benoemde plekken die bij je type passen (fabrieken, kastelen, havens, …) en je eigen omschrijving.
   - **OpenStreetMap**: plekken die Google niet als "plaats" kent, zoals industriegebieden, ruïnes, leegstaande gebouwen, silo's, bruggen en bossen.
   - **Steekproef**: gelijk verspreide punten over de hele zone. Zo vind je ook gewone straten en landwegen die nergens een naam hebben.
2. **Street View-dekking controleren** (gratis) en de plekken met een panorama houden.
3. **Gemini bekijkt** per plek 3 à 4 kijkrichtingen en geeft een score, palet en uitleg.
4. De resultaten verschijnen op de **resultatenpagina** in je browser.

## Installatie

Geen terminal nodig.

### 1. Node.js

Installeer [Node.js](https://nodejs.org) **22.18 of nieuwer** (kies "LTS").

### 2. Location Scout starten

Dubbelklik in de map `scout` op:

- **Mac**: `Start Location Scout.command`. De eerste keer weigert macOS misschien omdat het bestand van internet komt. Klik dan met de rechtermuisknop op het bestand → **Open** → **Open**.
- **Windows**: `Start Location Scout.bat`. Toont Windows een blauw venster ("Windows heeft uw pc beschermd")? Klik dan op **Meer informatie** → **Toch uitvoeren**.

De eerste keer worden de onderdelen geïnstalleerd; dat duurt een minuutje. Daarna opent Location Scout vanzelf in je browser, meestal op **http://127.0.0.1:4173**. Het juiste adres staat ook in het zwarte venster. Laat het zwarte venster open zolang je de app gebruikt.

### 3. Instellen in de app

De app opent de eerste keer op **Instellingen**:

1. **Google-sleutel** (voor kaarten en Street View). De pagina legt stap voor stap uit hoe je die aanmaakt, met directe links naar de vier API's. Plak hem en klik op **Test en bewaar**. De app test hem meteen bij Google en zegt wat er eventueel nog ontbreekt.
2. **Gemini-sleutel** (voor het beoordelen). Maak die gratis aan op [aistudio.google.com/apikey](https://aistudio.google.com/apikey). **Kies daarbij een nieuw project, zonder facturatie**, dus niet het project van stap 1. Zo blijft Gemini gratis. Plak hem en klik op **Test en bewaar**; de app doet een mini-testoproep om te zien of sleutel en model werken.

Daarna zoek je meteen bij **Nieuwe zoektocht**.

Onder Instellingen zie je ook hoeveel van het gratis Google-gebruik je deze maand al gebruikt hebt.

<details>
<summary>Liever met de terminal?</summary>

In de map `scout` installeert `npm run setup` de onderdelen en vraagt en test je Google-sleutel (en koppelt, optioneel, de Claude desktop-app). Daarna start `npm start` de app.
</details>

Gebruik je Claude Code in deze repo? Dan is de koppeling al ingesteld in `.mcp.json`.

## Gebruiken

Dubbelklik op het startbestand. Kies bij **Nieuwe zoektocht** je plaats, straal, type locatie, kleuren en wensen, en klik op **Zoek locaties**. Je ziet de resultaten binnenkomen terwijl de app zoekt. Met de gratis versie van Gemini duurt een zoektocht van 20 plekken een paar minuten. Onder *Eerdere zoektochten* vind je alles terug.

### Zie je nog een oude versie?

Staat er "Kopieer opdracht voor Claude" in plaats van **Zoek locaties**? Dan draait er nog een oudere versie, bijvoorbeeld via een eerdere koppeling met de Claude desktop-app. Sluit het zwarte venster en dubbelklik opnieuw op het startbestand: de nieuwe versie start dan op een vrij adres ernaast en opent je browser daar.

## Extra functies

### Zoeken op voorbeeldfoto
Kies bovenaan **Op voorbeeldfoto** en sleep 1 tot 4 foto's in het vak: een moodboard, een shot dat je mooi vindt, een eerdere locatie. Gemini bekijkt eerst wat voor plek het is (sfeer, materialen, kleuren) en vult je zoektocht daarmee aan. Daarna vergelijkt hij elke kandidaat met je voorbeelden. Op de kaartjes zie je hoeveel procent een plek erop lijkt.

### Waar is deze foto genomen?
Kies **Waar is deze foto?** en voeg één foto toe.
- Zitten er **GPS-gegevens** in de foto (meestal bij foto's rechtstreeks van een gsm), dan zie je meteen de exacte plek, met links naar Google Maps, Street View en een route. Daar is geen AI voor nodig.
- Zo niet (chat-apps en sociale media halen GPS weg), dan zoekt Gemini naar herkenningspunten, tekst op borden en architectuur. Hij maakt een paar gissingen, en de app vergelijkt de Street View-beelden ter plaatse met je foto. Een regio opgeven helpt veel.

### Meer zoals deze
Elke locatie heeft een knop **Meer zoals deze**. Die start een nieuwe zoektocht rond die plek (je kiest de straal), met het Street View-beeld van die plek als voorbeeld.

### Toegang en contact
- Elke locatie krijgt een label: **Publiek**, **Privé terrein** of **Toegang onduidelijk**, met de reden (een hek, een bord "privé", een openbare kade). Staat er in OpenStreetMap een toegangsregel, dan gaat die voor.
- **Zoek contact** vraagt op wie de eigenaar of uitbater is, met telefoon en website. Komt de plek uit Google Places, dan is dat de plek zelf. Anders komen de gegevens uit OpenStreetMap, of het is de dichtstbijzijnde zaak; dat laatste wordt er duidelijk bij vermeld, zodat je kunt controleren. Dit gebeurt alleen als je op de knop klikt, binnen het gratis gebruik van Google (1.000 per maand).

### Selectie delen met duimpjes
Markeer favorieten en klik op **Deel selectie**. Je krijgt een link naar een pagina waar je klant, model of team per locatie 👍 of 👎 kan geven, met een opmerking. Hun reacties verschijnen bij je resultaten en in het locatieboek. Ze zien geen notities of contactgegevens.

Omdat Location Scout op je eigen computer draait, werkt een link voor iemand anders alleen met de **internetlink** aan (in hetzelfde venster). Die gebruikt de gratis "quick tunnel" van Cloudflare. De eerste keer downloadt de app daarvoor het programma `cloudflared` (± 40 MB) van Cloudflare. De link werkt zolang Location Scout openstaat, en is bij elke herstart een nieuwe. Via die link is alleen de deelpagina bereikbaar; de rest van de app (instellingen, zoektochten, sleutels) niet.

### Locatieboek (PDF)
**Locatieboek (PDF)** maakt een document met een overzichtskaart en daarna per locatie één pagina: de foto's, een kaartje, lichtadvies, toegang, contact, je notities en de reacties. Neemt je favorieten, of alles wat getoond wordt. Kies in het afdrukvenster **Opslaan als PDF**.

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

## Optioneel: Claude via de API (betaald)

Staat er geen Gemini-sleutel maar wel een `ANTHROPIC_API_KEY` in `.env`, dan beoordeelt Claude de foto's via de API. Dat kost geld per gebruik: ongeveer $0,03 à $0,05 per plek. Google blijft ook dan binnen het gratis gebruik.

## Ontwikkelen

```bash
npm test           # tests, zonder sleutels of netwerk
npm run typecheck  # TypeScript-controle
```

De code is TypeScript en draait rechtstreeks met Node, zonder bouwstap:

- `src/gemini.ts`: de beoordeling door Gemini (gratis versie), ook van voorbeeldfoto's
- `src/contact.ts`: eigenaar en contact opzoeken
- `src/tunnel.ts`: de internetlink voor gedeelde selecties
- `public/share.*`, `public/print.*`: de deelpagina en het locatieboek
- `src/mcp.ts`: een optionele koppeling met de Claude desktop-app (in te stellen met `npm run setup`), los van de webapp
- `src/pipeline.ts`: het zoekproces
- `src/usage.ts`: de bewaking van het gratis Google-gebruik
- `src/presets.ts`: types, kleuren en extra wensen. Hier voeg je eenvoudig een nieuw type locatie toe.
- `src/server.ts` + `public/`: de resultatenpagina
