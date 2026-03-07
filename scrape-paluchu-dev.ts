import { Effect } from "effect"
import { parseHTML } from "linkedom"

const BASE_URL = "https://napaluchu.waw.pl"
const SOURCE_URL = `${BASE_URL}/zwierzeta/zwierzeta-do-adopcji/`

async function scrapeWithDevBrowser() {
  console.log("Starting dev-browser scraping for Schronisko na Paluchu...")
  
  // Create a new page
  const createPageRes = await fetch("http://localhost:9222/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "paluchu-scraper",
      viewport: { width: 1280, height: 720 }
    })
  })
  
  if (!createPageRes.ok) {
    throw new Error(`Failed to create page: ${createPageRes.status}`)
  }
  
  console.log("✓ Created browser page")
  
  // We'll need to use the CDP (Chrome DevTools Protocol) directly
  // For now, let's try a different approach - use the existing pages
  
  // Try to get the browser's WebSocket endpoint
  const browserRes = await fetch("http://localhost:9222/json")
  const browserInfo = await browserRes.json()
  console.log("Browser info:", JSON.stringify(browserInfo, null, 2))
}

scrapeWithDevBrowser().catch(console.error)
