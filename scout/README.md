# Location Scout

Vindt fotoshootlocaties voor je, zodat je niet uren door Google Maps en Street View hoeft te scrollen.

Je geeft een gemeente of stad op, met een straal in km. Je kiest het soort plek, de kleursetting en eventueel extra wensen. De tool zoekt dan kandidaat-plekken en bekijkt elke plek in Street View. Claude beoordeelt de beelden en je krijgt een gerangschikte lijst terug met:

- een score van 0 tot 100 en een korte beschrijving van de plek als shootlocatie;
- sterke punten en aandachtspunten (hekken, verkeer, rommel, …);
- het kleurpalet van de plek en hoe goed het past bij je gevraagde kleuren;
- lichtadvies: wanneer de zon goed staat voor de beste kijkrichting;
- de Street View-beelden zelf, een 360°-weergave, en links naar Street View en een route.

Markeer favorieten, wijs plekken af en schrijf notities (bv. "toestemming vragen"). Exporteer daarna naar **KML** (Google My Maps, Google Earth), **GPX** (gps, Komoot) of **CSV** (Excel). Elke zoektocht wordt bewaard. Je kunt hem later opnieuw openen of met dezelfde instellingen opnieuw starten.

## Hoe het zoekt

1. **Kandidaten verzamelen** uit drie bronnen, die je elk kunt uitzetten:
   - **Google Places**: benoemde plekken die bij je type passen (fabrieken, kastelen, havens, …) en je eigen omschrijving.
   - **OpenStreetMap**: plekken die Google niet als "plaats" kent, zoals industriegebieden, ruïnes, leegstaande gebouwen, silo's, bruggen en bossen.
   - **Steekproef**: gelijk verspreide punten over de hele zone. Zo vind je ook gewone straten en landwegen die nergens een naam hebben.
2. **Street View-dekking controleren.** Gratis, dus de tool bekijkt meer kandidaten dan nodig en houdt de plekken met een panorama.
3. **Beelden ophalen**: 3 of 4 kijkrichtingen per plek. Naar een benoemde plek wordt gericht gekeken; bij een steekproefpunt kijkt de tool alle kanten op.
4. **Beoordelen.** Claude bekijkt de beelden met jouw wensen als opdracht en geeft een score, palet en uitleg.

## Installatie

Je hebt [Node.js](https://nodejs.org) **22.18 of nieuwer** nodig.

```bash
cd scout
npm install
cp .env.example .env     # en vul de twee sleutels in
npm start
```

Open daarna **http://localhost:4173** in je browser.

### Sleutels

**Google Maps** (`GOOGLE_MAPS_API_KEY`). Maak in de [Google Cloud Console](https://console.cloud.google.com/) een project aan, met facturatie aan. Zet onder *APIs & Services → Library* deze API's aan:

| API | Waarvoor |
|---|---|
| Geocoding API | gemeente of stad omzetten naar een plek op de kaart |
| Places API (New) | benoemde plekken zoeken |
| Street View Static API | Street View-beelden ophalen en controleren of er dekking is |
| Maps Embed API | de 360°-weergave in de resultaten (gratis) |

Maak daarna onder *Credentials* een API-sleutel. Beperk die sleutel tot deze vier API's. De sleutel wordt ook gebruikt voor de 360°-weergave in je browser; de server luistert standaard alleen op je eigen computer.

**Claude** (`ANTHROPIC_API_KEY`): maak een sleutel aan op [console.anthropic.com](https://console.anthropic.com).

## Kosten

Voor je start, toont de tool een **maximale kost**. Tijdens het zoeken zie je de werkelijke kost oplopen. Richtprijzen (lijstprijzen, controleer de actuele prijzen bij Google en Anthropic):

- Street View-beeld: ± $0,007 per beeld, 3 à 4 per plek. Dekkingscontrole is gratis.
- Google Places-zoekopdracht: ± $0,03, ongeveer 3 per gekozen type.
- Claude-beoordeling: ± $0,03 à $0,05 per plek.

Een zoektocht met 40 plekken kost zo rond **$2 à $3**. Google geeft elke maand een gratis gebruikstegoed. Je stelt het aantal plekken in onder *Geavanceerd*; minder plekken betekent goedkoper, maar je ziet ook minder.

## Tips

- **Combineer types**, bijvoorbeeld *Industrieel* + *Water*, voor een silo aan het kanaal.
- **Beschrijf in eigen woorden** wat je zoekt. Die tekst wordt een extra zoekopdracht én deel van de beoordeling. Bijvoorbeeld: "lange rechte weg met bomenrij", "roestige loods met grote schuifdeur".
- **Kleur**: kies een of meer presets, of voeg met *+ kleur* je eigen kleuren toe (bv. uit een moodboard).
- **Beeld niet ouder dan …** sluit verouderde Street View-beelden uit. Gebouwen verdwijnen ook weleens.
- Een plek die verrast, bekijk je met **360° bekijken**; daarna kun je hem exporteren naar je telefoon.

## Goed om te weten

- Street View toont de plek vanaf de openbare weg. De score zegt iets over hoe de plek eruitziet, niet of je er mag fotograferen. "Vermoedelijk publiek toegankelijk" is een inschatting; vraag bij privéterrein altijd toestemming.
- Het lichtadvies is een vuistregel op basis van de kijkrichting, voor België en Nederland.
- De Street View-beelden worden alleen tijdens de sessie in het geheugen gehouden; zo vragen de voorwaarden van Google het. Bij een eerder bewaarde zoektocht zie je in de plaats daarvan de live 360°-weergave.
- Zoektochten staan als JSON-bestanden in `scout/data/searches/`.

## Ontwikkelen

```bash
npm test           # tests, zonder sleutels of netwerk
npm run typecheck  # TypeScript-controle
```

De code is TypeScript en draait rechtstreeks met Node, zonder bouwstap:

- `src/pipeline.ts`: het zoekproces
- `src/presets.ts`: types, kleuren en extra wensen. Hier voeg je eenvoudig een nieuw type locatie toe.
- `src/vision.ts`: de beoordeling door Claude
