import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs-extra";
import path from "path";

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
    console.log("🔍 Checking if the year dropdown exists...");
    await page.waitForSelector('select[name="year"]', { timeout: 30000 });

    const years = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("select[name='year'] option"))
        .map(option => ({
        value: option.value.trim(),
        text: option.innerText.trim(),
        }))
        .filter(opt => opt.value !== "" && opt.text !== "");
    });

    console.log(`📅 Found years:`, years);


    if (years.length === 0) {
    console.error("❌ No years found! Check if the website structure has changed.");
    return res.status(500).json({ error: "No years found." });
    }


  const dataDir = path.join(process.cwd(), "public", "CaseReference");
  await fs.ensureDir(dataDir);
  let caseData = {};
  for (const year of years) {
    console.log(`🟢 Processing Year: ${year.value}`);
    await page.select('select[name="year"]', year.value);
    await page.evaluate(() => document.querySelector('select[name="year"]').dispatchEvent(new Event('change')));
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log(`📚 Extracting volumes for Year: ${year.text}...`);
    const volumes = await getDropdownValues(page, 'select[name="volume"]');
    console.log(`Volumes for ${year.text}:`, volumes.map(v => v.text));

    caseData[year.text] = [];

    for (const volume of volumes) {
      try {
      await page.select('select[name="volume"]', volume.value);
      await page.evaluate(() => document.querySelector('select[name="volume"]').dispatchEvent(new Event('change')));
      await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`❌ Error selecting volume: ${volume.text}`, error);
        continue;
      }

      console.log(`📖 Checking if parts dropdown exists for Volume ${volume.text}...`);
      const isPartDropdownAvailable = await page.evaluate(() => {
        return document.querySelector("select[name='partno']") !== null;
      });

      //let parts = [];
      //if (isPartDropdownAvailable) {
        console.log(`🧐 Parts dropdown is available for Volume ${volume.text}. Extracting parts...`);
        //const parts = await page.evaluate(() => {
        //  return Array.from(document.querySelectorAll("select[name='partno'] option"))
        //    .map(option => option.value.trim())  // Ensure only string values are extracted
        //    .filter(value => value && typeof value === "string"); // Filter out empty & non-string values
        //});
      //}

      const parts = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("select[name='partno'] option"))
            .map(option => ({
            value: option.value.trim(),
            text: option.innerText.trim(),
            }))
            .filter(opt => opt.value !== "" && opt.text !== "");
        });

      if (parts.length === 0) {
        console.log(`⚠️ No parts dropdown for Volume ${volume.text}. Fetching cases directly.`);
        parts.push({ value: null, text: "No Part" });
      }
      console.log(`📅 Found Parts:`, parts);

      for (const part of parts) {
        console.log(`📌 Processing Part: ${part.value}`);
        // Wait only if the dropdown is present
        //await new Promise(resolve => setTimeout(resolve, 2000));
        await page.select('select[name="partno"]', part.value);
         // Set a shorter timeout to avoid hanging
        // await page.waitForSelector('select[name="partno"]', { timeout: 10000 }).catch(() => {
        //   console.log("⚠️ Part dropdown did not appear. Skipping parts selection.");
        // });
        await page.evaluate(() => document.querySelector('select[name="partno"]').dispatchEvent(new Event('change')));
        
        await new Promise(resolve => setTimeout(resolve, 3000));

        let caseDataForPart = await processJudgments(page, year.text, volume.text, part.value);
        caseData[year.text].push(...caseDataForPart);
      }
    }

    // Save year-wise data immediately
    if (caseData[year.text].length > 0) {
      const filePath = path.join(dataDir, `${year.text}.json`);
      await fs.writeJson(filePath, caseData[year.text], { spaces: 2 });
      console.log(`✅ Saved ${caseData[year.text].length} cases for Year: ${year.text}`);
    } else {
      console.warn(`⚠️ No data to save for Year: ${year.text}`);
    }
  }

  await browser.close();
  res.status(200).json({ message: "Scraping successful" });
}catch (error) {
    console.error("❌ Scraping Error:", error.message);
    return res.status(500).json({ error: "Scraping failed", details: error.message });
  }
}
// **Function to process judgments for a given year, volume, and part**
async function processJudgments(page, year, volume, part) {
  let caseData = [];

  console.log("🔍 Extracting judgment links...");
  const judgmentLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("li a[onclick]")).map((el) => {
      const onclickValue = el.getAttribute("onclick");
      const match = onclickValue.match(/view_judgment\('([^']+)','([^']+)'\)/);

      if (match) {
        return {
          base64_id: match[1],
          param2: match[2],
          text: el.innerText.trim(),
        };
      }
      return null;
    }).filter(Boolean);
  });

  if (judgmentLinks.length === 0) {
    console.warn(`⚠️ No links found for Year: ${year}, Volume: ${volume}, Part: ${part}`);
    return [];
  }

  for (let link of judgmentLinks) {
    try {
      console.log(`🔄 Refreshing page before processing: ${link.text}`);
      const baseURL = "https://digiscr.sci.gov.in/";

      await page.reload({ waitUntil: "networkidle2" });

      console.log(`🔄 Re-selecting Year: ${year}, Volume: ${volume}, Part: ${part}`);
      //console.log(`🔄 Navigating back to  to reselect the year.`);
        await page.goto(baseURL, { waitUntil: "networkidle2" });
        await new Promise(resolve => setTimeout(resolve, 5000));

// Debug: Check if year dropdown exists
        //const pageHTML = await page.evaluate(() => document.body.innerHTML);
        //console.log("🔍 Page HTML Snapshot:", pageHTML);

        // Ensure the year dropdown exists before interacting
        await page.waitForFunction(() => {
        return document.querySelector("select[name='year']") !== null;
        }, { timeout: 30000 });

        console.log("✅ Year dropdown is now available.");

      await new Promise(resolve => setTimeout(resolve, 2000));
      await page.select('select[name="volume"]', volume);
      await new Promise(resolve => setTimeout(resolve, 2000));

      if (part !== "No Part") {
        await page.select('select[name="partno"]', part);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      console.log(`📖 Opening case: ${link.text}`);
      await page.evaluate(id => {
        if (window.view_judgment) {
          window.view_judgment(id, "0");
        }
      }, link.base64_id);
      await new Promise(resolve => setTimeout(resolve, 10000));

      console.log(`✅ Successfully opened case: ${link.text}`);

      const caseReferred = await page.evaluate(() => {
        const rows = document.querySelectorAll("#dynamic_content tr");
        return Array.from(rows).map(row => {
          const cols = row.querySelectorAll("td");
          return {
            sr_no: cols[0]?.innerText.trim() || "",
            scr_citation: cols[1]?.innerText.trim() || "",
            judi_consi: cols[2]?.innerText.trim() || "",
            lnkd_judg_nm: cols[3]?.innerText.trim() || "",
          };
        }).filter(row => row.scr_citation);
      });

      if (caseReferred.length > 0) {
        caseData.push({
          judgmentId: link.base64_id,
          year,
          volume,
          part,
          caseReferred,
        });
      }

      await page.evaluate(() => {
        const closeButton = document.querySelector(".close-button") || document.querySelector(".btn-close");
        if (closeButton) {
          closeButton.click();
        }
      });

      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`❌ Error processing case: ${link.text}`, error);
    }
  }

  return caseData;
}

const getDropdownValues = async (page, selector) => {
    return await page.evaluate((sel) => {
      return Array.from(document.querySelectorAll(`${sel} option`))
        .map((option) => ({
          value: option.value,
          text: option.innerText.trim(),
        }))
        .filter((opt) => opt.value !== "");
    }, selector);
  };