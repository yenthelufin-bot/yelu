// What each location type means for the three candidate sources:
// - placesQueries: Google Places text searches (Dutch and English both work)
// - overpass: OpenStreetMap tag filters, as Overpass QL selectors
// - brief: how Claude should recognise the type in a Street View image

export interface LocationType {
  id: string;
  label: string;
  placesQueries: string[];
  overpass: string[];
  brief: string;
}

export const LOCATION_TYPES: LocationType[] = [
  {
    id: "industrieel",
    label: "Industrieel",
    placesQueries: ["industrieterrein", "fabriek", "loods", "silo", "containerterminal"],
    overpass: ['nwr["landuse"="industrial"]', 'nwr["man_made"~"^(silo|works|gasometer|storage_tank|chimney)$"]'],
    brief: "industrial setting: factories, warehouses, silos, metal sheds, pipes, cranes, containers, concrete yards",
  },
  {
    id: "landelijk",
    label: "Landelijk / agrarisch",
    placesQueries: ["boerderij", "hoeve", "schuur", "graanveld"],
    overpass: ['nwr["landuse"~"^(farmland|meadow|orchard|farmyard)$"]', 'nwr["building"~"^(barn|farm|stable)$"]'],
    brief: "rural / agricultural: open fields, farms, barns, country lanes, hedgerows, farm animals or machinery",
  },
  {
    id: "natuur",
    label: "Bos / natuur",
    placesQueries: ["bos", "natuurgebied", "heide", "wandelpad"],
    overpass: ['nwr["landuse"="forest"]', 'nwr["natural"~"^(wood|heath|scrub)$"]', 'nwr["leisure"="nature_reserve"]'],
    brief: "nature: forest, trees lining a path, heathland, dunes, untouched greenery with little built environment",
  },
  {
    id: "water",
    label: "Water / kust / haven",
    placesQueries: ["haven", "jachthaven", "kanaal", "strand", "meer", "sluis"],
    overpass: ['nwr["natural"~"^(water|beach|coastline)$"]', 'nwr["waterway"~"^(canal|river|dock)$"]', 'nwr["leisure"="marina"]'],
    brief: "water: canal, river, lake, harbour, quay, beach or coastline clearly visible",
  },
  {
    id: "stedelijk",
    label: "Stedelijk / straat",
    placesQueries: ["winkelstraat", "plein", "steeg", "oude binnenstad"],
    overpass: ['nwr["place"="square"]', 'way["highway"="pedestrian"]'],
    brief: "urban street: city streets, squares, alleys, storefronts, facades, urban texture",
  },
  {
    id: "verlaten",
    label: "Verlaten / vervallen",
    placesQueries: ["verlaten fabriek", "leegstaand gebouw", "ruïne", "abandoned building"],
    overpass: ['nwr["abandoned"="yes"]', 'nwr["disused"="yes"]', 'nwr["building"="ruins"]', 'nwr["historic"="ruins"]', 'nwr["abandoned:building"]'],
    brief: "abandoned / decayed: derelict buildings, boarded windows, overgrown structures, peeling paint, ruins",
  },
  {
    id: "historisch",
    label: "Historisch / kerk / kasteel",
    placesQueries: ["kasteel", "kerk", "abdij", "historisch gebouw", "molen"],
    overpass: ['nwr["historic"~"^(castle|manor|monument|church)$"]', 'nwr["building"~"^(church|chapel|cathedral)$"]', 'nwr["man_made"="windmill"]'],
    brief: "historic architecture: castles, churches, chapels, old brick or stone buildings, windmills, monuments",
  },
  {
    id: "modern",
    label: "Moderne architectuur",
    placesQueries: ["moderne architectuur", "kantoorgebouw", "museum", "glazen gevel"],
    overpass: ['nwr["building"~"^(office|commercial)$"]["building:levels"~"^([5-9]|[1-9][0-9])$"]'],
    brief: "modern architecture: clean lines, glass facades, minimalist concrete, contemporary buildings",
  },
  {
    id: "brutalisme",
    label: "Beton / brutalisme",
    placesQueries: ["brutalistisch gebouw", "betonnen gebouw", "parkeergarage"],
    overpass: ['nwr["building"="parking"]', 'nwr["amenity"="parking"]["parking"="multi-storey"]', 'nwr["building:material"="concrete"]'],
    brief: "raw concrete / brutalist: massive concrete volumes, parking garages, repetitive geometric structures",
  },
  {
    id: "streetart",
    label: "Graffiti / street art",
    placesQueries: ["street art", "graffiti muur", "muurschildering"],
    overpass: ['nwr["tourism"="artwork"]["artwork_type"~"^(mural|graffiti)$"]'],
    brief: "street art: graffiti walls, murals, painted surfaces with strong graphic colour",
  },
  {
    id: "infrastructuur",
    label: "Brug / tunnel / spoor",
    placesQueries: ["brug", "viaduct", "tunnel", "spoorwegbrug"],
    overpass: ['way["bridge"="yes"]["highway"]', 'way["tunnel"="yes"]["highway"]', 'way["railway"="rail"]["bridge"="yes"]'],
    brief: "infrastructure: bridges, viaducts, underpasses, tunnels, railway lines, strong leading lines",
  },
  {
    id: "weg",
    label: "Lange weg / bomenrij",
    placesQueries: ["dreef", "bomenlaan"],
    overpass: ['way["highway"~"^(tertiary|unclassified|track)$"]["lanes"!="4"]'],
    brief: "open road: long straight road or avenue, ideally lined with trees, vanishing point, little traffic",
  },
];

export interface ColorPreset {
  id: string;
  label: string;
  swatches: string[];
  brief: string;
}

export const COLOR_PRESETS: ColorPreset[] = [
  { id: "warm", label: "Warm / aards", swatches: ["#8b5a2b", "#c68642", "#d9a066", "#7a3e1d"], brief: "warm earthy tones: browns, ochre, terracotta, rust, sand" },
  { id: "koel", label: "Koel / blauw", swatches: ["#2f4858", "#33658a", "#86bbd8", "#9db4c0"], brief: "cool tones: blues, teal, steel, cold greys" },
  { id: "mono", label: "Monochroom / grijs", swatches: ["#222222", "#555555", "#999999", "#dddddd"], brief: "near-monochrome: greys, concrete, black and white, very low saturation" },
  { id: "pastel", label: "Pastel", swatches: ["#f4c2c2", "#c1e1c1", "#fdfd96", "#aec6cf"], brief: "soft pastel colours: light pinks, mint, baby blue, pale yellow" },
  { id: "fel", label: "Fel / kleurrijk", swatches: ["#e63946", "#f1c40f", "#2a9d8f", "#3a86ff"], brief: "bold saturated colours, strong colour contrast" },
  { id: "groen", label: "Groen dominant", swatches: ["#2d6a4f", "#40916c", "#74c69d", "#b7e4c7"], brief: "dominantly green: foliage, grass, moss" },
  { id: "baksteen", label: "Rode baksteen", swatches: ["#7f2f1f", "#a0412d", "#c0583d", "#5c2a1e"], brief: "red-brick and rust reds with neutral surroundings" },
  { id: "industrieel", label: "Roest & staal", swatches: ["#5a3e2b", "#8c5a3c", "#6c757d", "#343a40"], brief: "rust, weathered steel, dark greys, oxidised metal" },
];

export const EXTRA_FILTERS = [
  { id: "weinig_mensen", label: "Weinig verkeer en mensen", brief: "few or no people and cars in view" },
  { id: "geen_modern", label: "Geen storende moderne elementen", brief: "no distracting modern clutter (traffic signs, bins, parked cars, advertising)" },
  { id: "open_lucht", label: "Open lucht / horizon", brief: "plenty of open sky or a visible horizon" },
  { id: "lijnen", label: "Leidende lijnen / symmetrie", brief: "strong leading lines, symmetry or repetition" },
  { id: "diepte", label: "Diepte / gelaagdheid", brief: "depth with clear foreground, middle ground and background" },
  { id: "ruimte", label: "Ruimte voor een team", brief: "enough open space to set up a crew, lights and gear" },
  { id: "parkeren", label: "Parkeren in de buurt", brief: "visible place to park a car or van nearby" },
  { id: "toegankelijk", label: "Vermoedelijk publiek toegankelijk", brief: "appears to be public space rather than fenced private property" },
] as const;

export const SHOOT_TYPES = ["mode", "portret", "bruiloft", "product", "auto", "muziek / band", "sport", "editorial", "anders"] as const;

export function locationTypeById(id: string): LocationType | undefined {
  return LOCATION_TYPES.find((t) => t.id === id);
}

export function colorPresetById(id: string): ColorPreset | undefined {
  return COLOR_PRESETS.find((c) => c.id === id);
}
