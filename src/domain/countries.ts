/**
 * Where an academy is: the countries Sportozen offers when an academy is
 * created, and what each one means for the academy's defaults (currency, time
 * zone, date and number format, units) and its common cities.
 *
 * These are only starting points. Every default can be changed afterwards, and
 * nothing here converts money or moves an existing record: an academy keeps the
 * currency it was created with.
 */
export interface CountryInfo {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: string;
  /** ISO 4217. */
  currency: string;
  /** IANA time zones, the first being the usual default. */
  timezones: readonly string[];
  /** BCP 47 locale for dates and numbers. */
  locale: string;
  /** Distances in miles and weights in pounds are the everyday norm. */
  imperial?: boolean;
  /** Well-known cities, offered as suggestions (any city can be typed). */
  cities: readonly string[];
}

const c = (
  code: string,
  name: string,
  currency: string,
  timezones: string | readonly string[],
  locale: string,
  cities: readonly string[],
  imperial = false,
): CountryInfo => ({
  code,
  name,
  currency,
  timezones: typeof timezones === "string" ? [timezones] : timezones,
  locale,
  cities,
  ...(imperial ? { imperial } : {}),
});

export const COUNTRIES: readonly CountryInfo[] = [
  c("AR", "Argentina", "ARS", "America/Argentina/Buenos_Aires", "es-AR", [
    "Buenos Aires",
    "Córdoba",
    "Rosario",
    "Mendoza",
  ]),
  c(
    "AU",
    "Australia",
    "AUD",
    [
      "Australia/Sydney",
      "Australia/Melbourne",
      "Australia/Brisbane",
      "Australia/Adelaide",
      "Australia/Perth",
    ],
    "en-AU",
    ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Canberra"],
  ),
  c("AT", "Austria", "EUR", "Europe/Vienna", "de-AT", [
    "Vienna",
    "Graz",
    "Salzburg",
  ]),
  c("BH", "Bahrain", "BHD", "Asia/Bahrain", "en-BH", ["Manama"]),
  c("BD", "Bangladesh", "BDT", "Asia/Dhaka", "en-BD", [
    "Dhaka",
    "Chattogram",
    "Khulna",
  ]),
  c("BE", "Belgium", "EUR", "Europe/Brussels", "nl-BE", [
    "Brussels",
    "Antwerp",
    "Ghent",
  ]),
  c(
    "BR",
    "Brazil",
    "BRL",
    ["America/Sao_Paulo", "America/Manaus", "America/Fortaleza"],
    "pt-BR",
    [
      "São Paulo",
      "Rio de Janeiro",
      "Brasília",
      "Belo Horizonte",
      "Porto Alegre",
    ],
  ),
  c(
    "CA",
    "Canada",
    "CAD",
    [
      "America/Toronto",
      "America/Vancouver",
      "America/Edmonton",
      "America/Winnipeg",
      "America/Halifax",
    ],
    "en-CA",
    ["Toronto", "Vancouver", "Montreal", "Calgary", "Ottawa"],
  ),
  c("CL", "Chile", "CLP", "America/Santiago", "es-CL", [
    "Santiago",
    "Valparaíso",
    "Concepción",
  ]),
  c("CN", "China", "CNY", "Asia/Shanghai", "zh-CN", [
    "Shanghai",
    "Beijing",
    "Shenzhen",
    "Guangzhou",
  ]),
  c("CO", "Colombia", "COP", "America/Bogota", "es-CO", [
    "Bogotá",
    "Medellín",
    "Cali",
  ]),
  c("DK", "Denmark", "DKK", "Europe/Copenhagen", "da-DK", [
    "Copenhagen",
    "Aarhus",
    "Odense",
  ]),
  c("EG", "Egypt", "EGP", "Africa/Cairo", "ar-EG", [
    "Cairo",
    "Alexandria",
    "Giza",
  ]),
  c("ET", "Ethiopia", "ETB", "Africa/Addis_Ababa", "en-ET", [
    "Addis Ababa",
    "Dire Dawa",
  ]),
  c("FJ", "Fiji", "FJD", "Pacific/Fiji", "en-FJ", ["Suva", "Nadi"]),
  c("FR", "France", "EUR", "Europe/Paris", "fr-FR", [
    "Paris",
    "Marseille",
    "Lyon",
    "Toulouse",
    "Nice",
  ]),
  c("DE", "Germany", "EUR", "Europe/Berlin", "de-DE", [
    "Berlin",
    "Munich",
    "Hamburg",
    "Frankfurt",
    "Cologne",
  ]),
  c("GH", "Ghana", "GHS", "Africa/Accra", "en-GH", [
    "Accra",
    "Kumasi",
    "Tamale",
  ]),
  c("GR", "Greece", "EUR", "Europe/Athens", "el-GR", [
    "Athens",
    "Thessaloniki",
  ]),
  c("HK", "Hong Kong", "HKD", "Asia/Hong_Kong", "en-HK", ["Hong Kong"]),
  c("IN", "India", "INR", "Asia/Kolkata", "en-IN", [
    "Mumbai",
    "Delhi",
    "Bengaluru",
    "Hyderabad",
    "Chennai",
    "Kolkata",
    "Pune",
    "Ahmedabad",
  ]),
  c("ID", "Indonesia", "IDR", "Asia/Jakarta", "id-ID", [
    "Jakarta",
    "Surabaya",
    "Bandung",
    "Bali",
  ]),
  c("IE", "Ireland", "EUR", "Europe/Dublin", "en-IE", [
    "Dublin",
    "Cork",
    "Galway",
  ]),
  c("IL", "Israel", "ILS", "Asia/Jerusalem", "he-IL", [
    "Tel Aviv",
    "Jerusalem",
    "Haifa",
  ]),
  c("IT", "Italy", "EUR", "Europe/Rome", "it-IT", [
    "Rome",
    "Milan",
    "Naples",
    "Turin",
  ]),
  c("JM", "Jamaica", "JMD", "America/Jamaica", "en-JM", [
    "Kingston",
    "Montego Bay",
  ]),
  c("JP", "Japan", "JPY", "Asia/Tokyo", "ja-JP", [
    "Tokyo",
    "Osaka",
    "Yokohama",
    "Nagoya",
  ]),
  c("KE", "Kenya", "KES", "Africa/Nairobi", "en-KE", [
    "Nairobi",
    "Mombasa",
    "Kisumu",
  ]),
  c("KW", "Kuwait", "KWD", "Asia/Kuwait", "en-KW", ["Kuwait City"]),
  c("LK", "Sri Lanka", "LKR", "Asia/Colombo", "en-LK", [
    "Colombo",
    "Kandy",
    "Galle",
  ]),
  c("MY", "Malaysia", "MYR", "Asia/Kuala_Lumpur", "ms-MY", [
    "Kuala Lumpur",
    "Penang",
    "Johor Bahru",
  ]),
  c("MU", "Mauritius", "MUR", "Indian/Mauritius", "en-MU", ["Port Louis"]),
  c(
    "MX",
    "Mexico",
    "MXN",
    ["America/Mexico_City", "America/Monterrey", "America/Tijuana"],
    "es-MX",
    ["Mexico City", "Guadalajara", "Monterrey"],
  ),
  c("MA", "Morocco", "MAD", "Africa/Casablanca", "fr-MA", [
    "Casablanca",
    "Rabat",
    "Marrakesh",
  ]),
  c("NP", "Nepal", "NPR", "Asia/Kathmandu", "en-NP", [
    "Kathmandu",
    "Pokhara",
    "Lalitpur",
  ]),
  c("NL", "Netherlands", "EUR", "Europe/Amsterdam", "nl-NL", [
    "Amsterdam",
    "Rotterdam",
    "The Hague",
    "Utrecht",
  ]),
  c("NZ", "New Zealand", "NZD", "Pacific/Auckland", "en-NZ", [
    "Auckland",
    "Wellington",
    "Christchurch",
  ]),
  c("NG", "Nigeria", "NGN", "Africa/Lagos", "en-NG", [
    "Lagos",
    "Abuja",
    "Port Harcourt",
    "Kano",
  ]),
  c("NO", "Norway", "NOK", "Europe/Oslo", "nb-NO", [
    "Oslo",
    "Bergen",
    "Trondheim",
  ]),
  c("OM", "Oman", "OMR", "Asia/Muscat", "en-OM", ["Muscat", "Salalah"]),
  c("PK", "Pakistan", "PKR", "Asia/Karachi", "en-PK", [
    "Karachi",
    "Lahore",
    "Islamabad",
    "Rawalpindi",
  ]),
  c("PE", "Peru", "PEN", "America/Lima", "es-PE", [
    "Lima",
    "Arequipa",
    "Cusco",
  ]),
  c("PH", "Philippines", "PHP", "Asia/Manila", "en-PH", [
    "Manila",
    "Cebu",
    "Davao",
  ]),
  c("PL", "Poland", "PLN", "Europe/Warsaw", "pl-PL", [
    "Warsaw",
    "Kraków",
    "Gdańsk",
  ]),
  c("PT", "Portugal", "EUR", "Europe/Lisbon", "pt-PT", [
    "Lisbon",
    "Porto",
    "Braga",
  ]),
  c("QA", "Qatar", "QAR", "Asia/Qatar", "en-QA", ["Doha", "Al Rayyan"]),
  c("SA", "Saudi Arabia", "SAR", "Asia/Riyadh", "en-SA", [
    "Riyadh",
    "Jeddah",
    "Dammam",
    "Mecca",
  ]),
  c("SG", "Singapore", "SGD", "Asia/Singapore", "en-SG", ["Singapore"]),
  c("ZA", "South Africa", "ZAR", "Africa/Johannesburg", "en-ZA", [
    "Johannesburg",
    "Cape Town",
    "Durban",
    "Pretoria",
  ]),
  c("KR", "South Korea", "KRW", "Asia/Seoul", "ko-KR", [
    "Seoul",
    "Busan",
    "Incheon",
  ]),
  c("ES", "Spain", "EUR", "Europe/Madrid", "es-ES", [
    "Madrid",
    "Barcelona",
    "Valencia",
    "Seville",
  ]),
  c("SE", "Sweden", "SEK", "Europe/Stockholm", "sv-SE", [
    "Stockholm",
    "Gothenburg",
    "Malmö",
  ]),
  c("CH", "Switzerland", "CHF", "Europe/Zurich", "de-CH", [
    "Zurich",
    "Geneva",
    "Basel",
    "Bern",
  ]),
  c("TZ", "Tanzania", "TZS", "Africa/Dar_es_Salaam", "en-TZ", [
    "Dar es Salaam",
    "Dodoma",
    "Arusha",
  ]),
  c("TH", "Thailand", "THB", "Asia/Bangkok", "th-TH", [
    "Bangkok",
    "Chiang Mai",
    "Phuket",
  ]),
  c("TT", "Trinidad and Tobago", "TTD", "America/Port_of_Spain", "en-TT", [
    "Port of Spain",
    "San Fernando",
  ]),
  c("TR", "Turkey", "TRY", "Europe/Istanbul", "tr-TR", [
    "Istanbul",
    "Ankara",
    "Izmir",
  ]),
  c("UG", "Uganda", "UGX", "Africa/Kampala", "en-UG", ["Kampala", "Entebbe"]),
  c("AE", "United Arab Emirates", "AED", "Asia/Dubai", "en-AE", [
    "Dubai",
    "Abu Dhabi",
    "Sharjah",
  ]),
  c("GB", "United Kingdom", "GBP", "Europe/London", "en-GB", [
    "London",
    "Manchester",
    "Birmingham",
    "Liverpool",
    "Glasgow",
    "Leeds",
    "Edinburgh",
  ]),
  c(
    "US",
    "United States",
    "USD",
    [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "America/Anchorage",
      "Pacific/Honolulu",
    ],
    "en-US",
    [
      "New York",
      "Los Angeles",
      "Chicago",
      "Houston",
      "Phoenix",
      "Seattle",
      "Miami",
      "Atlanta",
    ],
    true,
  ),
  c("UY", "Uruguay", "UYU", "America/Montevideo", "es-UY", ["Montevideo"]),
  c("VN", "Vietnam", "VND", "Asia/Ho_Chi_Minh", "vi-VN", [
    "Ho Chi Minh City",
    "Hanoi",
    "Da Nang",
  ]),
];

/** Currencies on offer: every currency of the countries above, plus the common
 * ones a club may bill in from abroad. */
const CURRENCY_NAMES: Record<string, string> = {
  AED: "UAE dirham",
  ARS: "Argentine peso",
  AUD: "Australian dollar",
  BDT: "Bangladeshi taka",
  BHD: "Bahraini dinar",
  BRL: "Brazilian real",
  CAD: "Canadian dollar",
  CHF: "Swiss franc",
  CLP: "Chilean peso",
  CNY: "Chinese yuan",
  COP: "Colombian peso",
  DKK: "Danish krone",
  EGP: "Egyptian pound",
  ETB: "Ethiopian birr",
  EUR: "Euro",
  FJD: "Fijian dollar",
  GBP: "British pound",
  GHS: "Ghanaian cedi",
  HKD: "Hong Kong dollar",
  IDR: "Indonesian rupiah",
  ILS: "Israeli shekel",
  INR: "Indian rupee",
  JMD: "Jamaican dollar",
  JPY: "Japanese yen",
  KES: "Kenyan shilling",
  KRW: "South Korean won",
  KWD: "Kuwaiti dinar",
  LKR: "Sri Lankan rupee",
  MAD: "Moroccan dirham",
  MUR: "Mauritian rupee",
  MXN: "Mexican peso",
  MYR: "Malaysian ringgit",
  NGN: "Nigerian naira",
  NOK: "Norwegian krone",
  NPR: "Nepalese rupee",
  NZD: "New Zealand dollar",
  OMR: "Omani rial",
  PEN: "Peruvian sol",
  PHP: "Philippine peso",
  PKR: "Pakistani rupee",
  PLN: "Polish zloty",
  QAR: "Qatari riyal",
  SAR: "Saudi riyal",
  SEK: "Swedish krona",
  SGD: "Singapore dollar",
  THB: "Thai baht",
  TRY: "Turkish lira",
  TTD: "Trinidad and Tobago dollar",
  TZS: "Tanzanian shilling",
  UGX: "Ugandan shilling",
  USD: "US dollar",
  UYU: "Uruguayan peso",
  VND: "Vietnamese dong",
  ZAR: "South African rand",
};
export const CURRENCIES: readonly { code: string; name: string }[] =
  Object.entries(CURRENCY_NAMES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

export const DEFAULT_COUNTRY = "IN";
const byCode = new Map(COUNTRIES.map((country) => [country.code, country]));
export const countryInfo = (code: string) => byCode.get(code);

/** What choosing a country fills in, until the owner changes it. */
export function regionalDefaults(code: string) {
  const country = byCode.get(code) ?? byCode.get(DEFAULT_COUNTRY)!;
  return {
    country: country.code,
    currency: country.currency,
    timezone: country.timezones[0],
    dateLocale: country.locale,
    measurementSystem: country.imperial
      ? ("IMPERIAL" as const)
      : ("METRIC" as const),
  };
}
export const currencyName = (code: string) => CURRENCY_NAMES[code];
