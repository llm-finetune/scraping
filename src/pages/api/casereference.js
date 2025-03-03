import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";

puppeteer.use(StealthPlugin());

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const baseURL = "https://digiscr.sci.gov.in/";

  try {
    console.log("🚀 Launching browser...");
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/91.0.4472.124 Safari/537.36"
    );

    console.log(`🔗 Navigating to ${baseURL}...`);
    await page.goto(baseURL, { waitUntil: "networkidle2" });

    // **Extract all available years from the dropdown**
    const availableYears = await page.evaluate(() => {
      return [...document.querySelectorAll("select[name='year'] option")]
        .map(option => option.value.trim())
        .filter(value => value);
    });

    console.log(`📅 Found years:`, availableYears);

    for (const year of availableYears) {
      console.log(`🟢 Processing year: ${year}`);
      await page.select("select[name='year']", year);
      await page.evaluate(() => document.querySelector("select[name='year']").dispatchEvent(new Event('change')));
      await new Promise(resolve => setTimeout(resolve, 5000));

      let caseData = [];

      // **Extract all available volumes for the selected year**
      const availableVolumes = await page.evaluate(() => {
        return [...document.querySelectorAll("select[name='volume'] option")]
          .map(option => option.value.trim())
          .filter(value => value);
      });

      console.log(`📚 Found volumes for ${year}:`, availableVolumes);

      // **Check if parts dropdown is available**
      const isPartsAvailable = await page.evaluate(() => {
        const partDropdown = document.querySelector("select[name='partno']");
        return partDropdown && !partDropdown.disabled && partDropdown.offsetParent !== null;
      });

      console.log(`🧐 Parts dropdown ${isPartsAvailable ? "is available ✅" : "is NOT available ❌"} for year ${year}`);

      for (const volume of availableVolumes) {
        console.log(`🔄 Processing Volume: ${volume}`);
        await page.select("select[name='volume']", volume);
        await page.evaluate(() => document.querySelector("select[name='volume']").dispatchEvent(new Event('change')));
        await new Promise(resolve => setTimeout(resolve, 8000));

        if (isPartsAvailable) {
          const availableParts = await page.evaluate(() => {
            return [...document.querySelectorAll("select[name='partno'] option")]
              .map(option => option.value.trim())
              .filter(value => value);
          });

          console.log(`📖 Found parts for Volume ${volume} in ${year}:`, availableParts.length > 0 ? availableParts : "❌ No Parts Found");

          for (const part of availableParts) {
            console.log(`📌 Processing Part: ${part}`);
            await page.select("select[name='partno']", part);
            await page.evaluate(() => document.querySelector("select[name='partno']").dispatchEvent(new Event('change')));
            await new Promise(resolve => setTimeout(resolve, 8000));

            const caseDataForPart = await scrapeJudgments(page, year, volume, part);
            caseData.push(...caseDataForPart);
          }
        } else {
          console.log(`📄 Fetching judgments for Year ${year}, Volume ${volume} (No Parts)`);
          const caseDataForVolume = await scrapeJudgments(page, year, volume, null);
          caseData.push(...caseDataForVolume);
        }
      }

      // **Ensure year-wise data is written immediately**
      if (caseData.length > 0) {
        console.log(`📝 Writing ${caseData.length} records to cases_${year}.json...`);

        const dir = "./public";
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir);
        }

        const fileName = `./public/cases_${year}.json`;
        fs.writeFileSync(fileName, JSON.stringify(caseData, null, 2));
        console.log(`✅ Data for Year ${year} saved in: ${fileName}`);
      } else {
        console.log(`⚠️ No case data found for Year ${year}, skipping file creation.`);
      }
    }

    console.log("🚀 Scraping and file saving completed!");
    await browser.close();
    return res.status(200).json({ message: "Scraping completed!" });

  } catch (error) {
    console.error("❌ Scraping Error:", error.message);
    return res.status(500).json({ error: "Scraping failed", details: error.message });
  }
}

// **Function to scrape judgment data with formatted JSON output**
async function scrapeJudgments(page, year, volume, part) {
  let caseData = [];

  const judgmentLinks = await page.evaluate(() => {
    return [...document.querySelectorAll("a[onclick^='view_judgment(']")].map(link => {
      const match = link.getAttribute("onclick").match(/'([^']+)'/);
      return match ? match[1] : null;
    }).filter(Boolean);
  });

  console.log(`✅ Found ${judgmentLinks.length} judgments for Year ${year}, Volume ${volume}, Part ${part || "N/A"}`);

  for (const judgmentId of judgmentLinks) {
    console.log(`🟢 Processing Judgment ID: ${judgmentId}`);

    await page.evaluate(id => {
      if (window.view_judgment) {
        window.view_judgment(id, "0");
      }
    }, judgmentId);
    await new Promise(resolve => setTimeout(resolve, 10000));

    const isCaseReferredVisible = await page.evaluate(() => {
      const content = document.querySelector("#dynamic_content");
      return content && content.offsetParent !== null;
    });

    if (!isCaseReferredVisible) {
      console.log(`⚠️ Skipping Judgment ID ${judgmentId} - Case Referred section not visible.`);
      continue;
    }

    const rawCaseReferred = await page.evaluate(() => {
      const content = document.querySelector("#dynamic_content");
      if (!content) return [];
      const caseElements = content.querySelectorAll("tr td");
      return [...caseElements].map(el => el.innerText.trim()).filter(text => text);
    });

    let formattedCaseReferred = [];

    for (let i = 0; i < rawCaseReferred.length; i += 4) {
      formattedCaseReferred.push({
        "sr_no": rawCaseReferred[i] || "",
        "scr_citation": rawCaseReferred[i + 1] || "",
        "judi_consi": rawCaseReferred[i + 2] || "",
        "lnkd_judg_nm": rawCaseReferred[i + 3] || ""
      });
    }

    if (formattedCaseReferred.length > 0) {
      console.log(`📄 Extracted 'Case referred' for Judgment ID ${judgmentId}:`, formattedCaseReferred);
      caseData.push({ judgmentId, volume, part, caseReferred: formattedCaseReferred });
    } else {
      console.log(`❌ No 'Case referred' found for Judgment ID: ${judgmentId}`);
    }
  }

  return caseData;
}
