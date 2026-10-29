# Frame Finder online zetten

Zo draait Frame Finder op **https://framefinder.yeluvisuals.com**, met een wachtwoord, zodat je het overal kunt gebruiken en testers kunt uitnodigen. Reken op ongeveer een halfuur.

Je hebt nodig:

- je GitHub-account (waar deze code staat);
- een account bij [Railway](https://railway.com), de dienst die de app laat draaien. Het Hobby-abonnement kost ongeveer $5 per maand, en dat bedrag geldt ook als tegoed voor het gebruik. Een kleine app als deze blijft daar meestal binnen;
- je Squarespace-account, voor het domein;
- je Google- en Gemini-sleutel (dezelfde als op je computer).

## 1. De app op Railway zetten

1. Log in op [railway.com](https://railway.com) met je GitHub-account en kies het **Hobby**-abonnement.
2. Klik op **New Project → Deploy from GitHub repo** en kies **yenthelufin-bot/yelu**. Geef Railway toegang tot die repository als het daarom vraagt.
3. Open de dienst die verschijnt en ga naar **Settings**:
   - **Source → Root Directory**: vul `/scout` in. Railway vindt daar de `Dockerfile` en bouwt de app zelf.
   - **Branch**: kies de branch met de laatste versie (nu `claude/location-scout`).
4. Ga naar **Variables** en voeg toe:

   | Naam | Waarde |
   |---|---|
   | `FRAMEFINDER_PASSWORD` | Een wachtwoord van minstens 10 tekens. Dit geef je aan je testers. |
   | `GOOGLE_MAPS_API_KEY` | Je Google-sleutel |
   | `GEMINI_API_KEY` | Je Gemini-sleutel |
   | `GEMINI_MODEL` | `gemini-3.5-flash-lite` (of het model dat je nu gebruikt) |
   | `GOOGLE_EMBED_KEY` | Optioneel, voor de 360°-weergave: zie stap 4 |

5. Voeg een **Volume** toe (rechtsklik op de dienst, of **+ New → Volume**) en zet het **mount path** op `/data`. Daar bewaart de app de zoektochten, deellinks en stemmen. Zonder volume ben je die kwijt bij elke update.
6. Wacht tot de build klaar is. Ga dan naar **Settings → Networking → Generate Domain**. Je krijgt een adres zoals `frame-finder-production.up.railway.app`. Open het: je ziet het inlogscherm van Frame Finder.

## 2. Je eigen adres: framefinder.yeluvisuals.com

1. In Railway: **Settings → Networking → Custom Domain**, vul `framefinder.yeluvisuals.com` in, met poort `8080`. Railway toont welk record je moet toevoegen: een **CNAME** met een doel dat eindigt op `.up.railway.app`, en soms ook een **TXT**-record om te bevestigen dat het domein van jou is.
2. In Squarespace: **Domeinen → yeluvisuals.com → DNS → DNS-instellingen**. Bij **Aangepaste records** klik je op **Record toevoegen**:
   - Host: `framefinder`
   - Type: `CNAME`
   - Data: het doel dat Railway gaf
   - Vraagt Railway ook een TXT-record? Voeg het op dezelfde manier toe, met de Host en Data die Railway toont.
3. Wacht een kwartier tot (zelden) een dag. Railway zet zelf het slotje (https) op het adres zodra het record werkt.

Je gewone website op yeluvisuals.com blijft gewoon werken: je voegt alleen een subdomein toe.

## 3. Een pagina op je Squarespace-site

1. Maak in Squarespace een nieuwe pagina, bijvoorbeeld **Frame Finder**. Zet ze eventueel bij **Niet gelinkt** als ze (nog) niet in je menu mag.
2. Zet er wat uitleg op, met een **Knop**-blok dat linkt naar `https://framefinder.yeluvisuals.com`.

De app zelf in de pagina tonen (met een insluitcode) is mogelijk, maar werkt minder goed op een gsm en geeft problemen met inloggen. Een knop naar het subdomein werkt het beste.

## 4. Aangeraden: een aparte sleutel voor de 360°-weergave

De 360°-weergave in de browser heeft een Google-sleutel nodig die bezoekers kunnen zien. Online stuurt Frame Finder je gewone sleutel daarom **nooit** naar de browser. Zonder aparte sleutel werkt alles, behalve de knop 360°.

1. In [Google Cloud](https://console.cloud.google.com), in hetzelfde project: **API's en services → Inloggegevens → + Inloggegevens maken → API-sleutel**.
2. Bewerk de nieuwe sleutel:
   - **Toepassingsbeperkingen → Websites**: voeg `https://framefinder.yeluvisuals.com/*` toe;
   - **API-beperkingen**: alleen **Maps Embed API**.
3. Zet hem in Railway als `GOOGLE_EMBED_KEY`.

## Goed om te weten

- **Deellinks werken nu meteen voor iedereen.** De internetlink via Cloudflare heb je online niet nodig.
- **Gratis gebruik:** de teller van Google's gratis gebruik staat apart op de server en op je computer. Ze delen wel hetzelfde Google-tegoed. Gebruik je beide veel, dan kan je samen over de gratis grens gaan. Gebruik daarom bij voorkeur één van de twee, of zet de online versie op een eigen Google-project met een eigen sleutel.
- **Het wachtwoord veranderen** doe je in Railway bij Variables. Iedereen wordt dan uitgelogd.
- **Updates:** elke nieuwe versie op de gekozen branch zet Railway vanzelf online.
- **Gemini's gratis versie** mag wat je stuurt (ook de voorbeeldfoto's van testers) gebruiken om Google's modellen te verbeteren. Vertel dat aan je testers.
- **Veiligheid:** zonder `FRAMEFINDER_PASSWORD` weigert de server te starten, zodat hij nooit open op internet staat. Na 10 foute wachtwoorden wordt een adres een kwartier geblokkeerd.
