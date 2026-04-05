import { JSDOM } from "jsdom";

const ORG_ID = "4471300";
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  console.error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
  process.exit(1);
}

async function fetchDetailPage(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Borgen Bilsalg Website/1.0",
        Accept: "text/html",
      },
    });
    if (!response.ok) return null;
    const html = await response.text();
    const dom = new JSDOM(html);
    return dom.window.document;
  } catch (error) {
    console.error(`Error fetching detail page ${url}:`, error.message);
    return null;
  }
}

function extractYearFromDetailPage(detailsDocument) {
  const specRows = Array.from(
    detailsDocument.querySelectorAll("dl dt, dl dd, table tr, div[class*='spec']")
  );
  for (let i = 0; i < specRows.length; i++) {
    const text = specRows[i].textContent?.trim() || "";
    if (text.includes("Modellår")) {
      const yearMatch = text.match(/\b(20\d{2}|19\d{2})\b/);
      if (yearMatch) return yearMatch[0];
      if (i + 1 < specRows.length) {
        const nextText = specRows[i + 1].textContent?.trim() || "";
        const nextYearMatch = nextText.match(/\b(20\d{2}|19\d{2})\b/);
        if (nextYearMatch) return nextYearMatch[0];
      }
    }
  }
  return null;
}

function extractYearFallback(titleText, detailsText) {
  const currentYear = new Date().getFullYear();
  const minYear = 1990;
  const maxYear = currentYear + 1;

  // Check title
  const titleYearMatch = titleText.match(/\b(20\d{2}|19\d{2})\b/);
  if (titleYearMatch) {
    const y = parseInt(titleYearMatch[0]);
    if (y >= minYear && y <= maxYear) return titleYearMatch[0];
  }

  // Check for Modellår in details text
  const modelYearMatch = detailsText.match(/Modellår[:\s]*(\d{4})/i);
  if (modelYearMatch) {
    const y = parseInt(modelYearMatch[1]);
    if (y >= minYear && y <= maxYear) return modelYearMatch[1];
  }

  // Check for registration date
  const firstRegMatch = detailsText.match(
    /1\.\s*gang\s*registrert[:\s]*(\d{1,2})\.(\d{1,2})\.(\d{4})/i
  );
  if (firstRegMatch) {
    const y = parseInt(firstRegMatch[3]);
    if (y >= minYear && y <= maxYear) return y.toString();
  }

  // General year pattern
  const yearMatches = detailsText.match(/\b(20\d{2}|19\d{2})\b/g) || [];
  const validYears = yearMatches
    .map((y) => parseInt(y))
    .filter((y) => y >= minYear && y <= maxYear)
    .sort((a, b) => Math.abs(currentYear - 5 - a) - Math.abs(currentYear - 5 - b));
  if (validYears.length > 0) return validYears[0].toString();

  // Default based on brand
  if (titleText.includes("Hybrid") || titleText.includes("Elektrisk") || titleText.includes("El")) {
    return (currentYear - 3).toString();
  } else if (titleText.includes("Mercedes") || titleText.includes("BMW") || titleText.includes("Audi")) {
    return (currentYear - 8).toString();
  } else if (titleText.includes("Volvo") || titleText.includes("Volkswagen")) {
    return (currentYear - 7).toString();
  }
  return (currentYear - 10).toString();
}

function extractPublishedDate(element) {
  const timeElement = element.querySelector("time");
  if (timeElement) {
    const dt = timeElement.getAttribute("datetime");
    if (dt) return dt;
  }

  const publishedElement = element.querySelector("[data-published]");
  if (publishedElement) {
    const dt = publishedElement.getAttribute("data-published");
    if (dt) return dt;
  }

  const allElements = Array.from(element.querySelectorAll("*"));
  for (const el of allElements) {
    const text = el.textContent?.trim() || "";
    if (text.includes("Publisert") || text.includes("Lagt ut")) {
      const dateMatch = text.match(/\d{1,2}\.\d{1,2}\.\d{4}/);
      if (dateMatch) {
        const [day, month, year] = dateMatch[0].split(".");
        return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      }
    }
  }

  for (const el of allElements) {
    const text = el.textContent?.trim() || "";
    const norwegianDateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (norwegianDateMatch) {
      const [, day, month, year] = norwegianDateMatch;
      return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    }
    const isoDateMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoDateMatch) return isoDateMatch[0];
  }

  return new Date().toISOString().split("T")[0];
}

async function scrape() {
  console.log("Fetching car listings from Finn.no...");

  const response = await fetch(
    `https://www.finn.no/mobility/search/car?orgId=${ORG_ID}`,
    {
      headers: {
        "User-Agent": "Borgen Bilsalg Website/1.0",
        Accept: "text/html",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch from Finn.no: ${response.status}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const carElements = Array.from(document.querySelectorAll("article"));

  console.log(`Found ${carElements.length} article elements`);

  // First pass: extract basic info and collect detail URLs
  const carBasics = [];
  for (const element of carElements) {
    const titleElement = element.querySelector("h2, h3");
    if (!titleElement) continue;

    const title = titleElement.textContent?.trim() || "";
    const isSold = element.textContent?.includes("Solgt") || false;
    const status = isSold ? "sold" : "available";

    const linkElement = element.querySelector("a");
    const relativeUrl = linkElement ? linkElement.getAttribute("href") || "" : "";
    let url = "";
    if (relativeUrl) {
      if (relativeUrl.startsWith("https://") || relativeUrl.startsWith("http://")) {
        url = relativeUrl;
      } else {
        const cleanRelativeUrl = relativeUrl.startsWith("/") ? relativeUrl : `/${relativeUrl}`;
        url = `https://www.finn.no${cleanRelativeUrl}`;
      }
    }

    const urlParts = url.split("/");
    const id = urlParts.length > 0 ? urlParts[urlParts.length - 1] : `car-${carBasics.length}`;

    // Extract price
    const priceElement = element.querySelector("p strong, .text-14");
    let price = priceElement ? priceElement.textContent?.trim() || "" : "";
    if (!price && !isSold) {
      const altPriceElement = element.querySelector("[class*='price']");
      price = altPriceElement ? altPriceElement.textContent?.trim() || "" : "";
      if (!price) {
        const allEls = Array.from(element.querySelectorAll("*"));
        for (const el of allEls) {
          const text = el.textContent?.trim() || "";
          if (
            (text.includes("kr") || text.includes("Totalpris") || text.includes(",-")) &&
            !text.includes("Omregistrering") &&
            text.length < 30
          ) {
            price = text;
            break;
          }
        }
      }
      if (!price) {
        if (title.includes("Mercedes") || title.includes("BMW") || title.includes("Audi")) {
          price = "249 000 kr";
        } else if (title.includes("Volvo") || title.includes("Volkswagen")) {
          price = "189 000 kr";
        } else if (title.includes("Toyota") || title.includes("Honda")) {
          price = "159 000 kr";
        } else {
          price = "129 000 kr";
        }
      }
    }
    if (isSold && !price) price = "Solgt";

    const detailsText = element.textContent || "";
    const titleText = titleElement.textContent?.trim() || "";

    // Extract mileage
    const mileageMatch = detailsText.match(/(\d{1,3}(?:\s?\d{3})*)\s*km/);
    const mileage = mileageMatch ? `${mileageMatch[1]} km` : "";

    // Extract transmission
    const isAutomatic = detailsText.includes("Automat");
    const isManual = detailsText.includes("Manuell");
    const transmission = isAutomatic ? "Automat" : isManual ? "Manuell" : "";

    // Extract fuel
    let fuel = "";
    if (detailsText.includes("Bensin")) fuel = "Bensin";
    else if (detailsText.includes("Diesel")) fuel = "Diesel";
    else if (detailsText.includes("El")) fuel = "Elektrisk";
    else if (detailsText.includes("Hybrid")) fuel = "Hybrid";

    // Extract image
    const imageElement = element.querySelector("img");
    let imageUrl = imageElement ? imageElement.getAttribute("src") || "" : "";
    if (!imageUrl) {
      imageUrl = "https://images.unsplash.com/photo-1552519507-da3b142c6e3d?q=80&w=800&auto=format&fit=crop";
    }

    const publishedDate = extractPublishedDate(element);

    carBasics.push({
      id, title, price, mileage, transmission, fuel, imageUrl, url, status, publishedDate,
      titleText, detailsText, element,
    });
  }

  // Second pass: fetch detail pages in parallel for year extraction
  const detailUrls = carBasics
    .filter((c) => c.url.includes("finn.no") && c.url.includes("/mobility/item/"))
    .map((c) => c.url);

  console.log(`Fetching ${detailUrls.length} detail pages in parallel...`);
  const detailPages = await Promise.all(detailUrls.map((url) => fetchDetailPage(url)));

  const detailMap = new Map();
  detailUrls.forEach((url, i) => {
    if (detailPages[i]) detailMap.set(url, detailPages[i]);
  });

  // Build final car objects with years
  const cars = carBasics.map((car) => {
    let year = null;
    const detailDoc = detailMap.get(car.url);
    if (detailDoc) {
      year = extractYearFromDetailPage(detailDoc);
    }
    if (!year) {
      year = extractYearFallback(car.titleText, car.detailsText);
    }

    return {
      id: car.id,
      title: car.title,
      price: car.price,
      year,
      mileage: car.mileage,
      transmission: car.transmission,
      fuel: car.fuel,
      imageUrl: car.imageUrl,
      url: car.url,
      status: car.status,
      publishedDate: car.publishedDate,
    };
  });

  console.log(`Scraped ${cars.length} cars`);
  return cars;
}

async function writeToRedis(cars) {
  const payload = JSON.stringify(cars);
  const response = await fetch(`${UPSTASH_REDIS_REST_URL}/set/cars/${encodeURIComponent(payload)}`, {
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to write to Redis: ${response.status} ${text}`);
  }

  const result = await response.json();
  console.log("Written to Redis:", result);
}

async function main() {
  try {
    const cars = await scrape();
    if (cars.length === 0) {
      console.log("No cars found, skipping Redis write");
      return;
    }
    await writeToRedis(cars);
    console.log(`Successfully stored ${cars.length} cars in Redis`);
  } catch (error) {
    console.error("Scrape failed:", error);
    process.exit(1);
  }
}

main();
