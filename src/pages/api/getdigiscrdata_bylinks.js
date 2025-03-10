import puppeteer from "puppeteer";
import fs from "fs-extra";
import path from "path";
const { chromium } = require("playwright");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Only GET requests allowed" });
  }

  let initialBrowser = null;
  let scrapingBrowser = null;

  try {
    initialBrowser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await initialBrowser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1280, height: 800 });

    console.log("Navigating to site...");
    await page.goto("https://digiscr.sci.gov.in", { waitUntil: "networkidle2" });

    //await page.waitForSelector('select[name="year"]', { timeout: 15000 });
    // Get all available years
    await page.waitForSelector("select[name='year']", { timeout: 15000 });
    const years = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("select[name='year'] option"))
        .map(option => option.value)
        .filter(value => value);
    });

    console.log(`Found ${years.length} years to process.`);
   
    const dataDir = path.join(process.cwd(), "public", "data");
    await fs.ensureDir(dataDir);

    for (const year of years) {
      if (year !== "2023") {
        continue;
      }
      //check if year json file exists
      const yearfilePath = path.join(dataDir, `Links_${year}.json`);
      if (!fs.existsSync(yearfilePath)) {
        console.log(`Links for Year ${year} already exist. Skipping...`);
        
     
      console.log(`Processing Year: ${year}`);
      await page.select("select[name='year']", year);
      await new Promise(resolve => setTimeout(resolve, 3000));

      const volumes = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("select[name='volume'] option"))
          .map(option => ({ value: option.value, text: option.innerText.trim() }))
          .filter(opt => opt.value !== "");
      });

      console.log(`Found ${volumes.length} volumes for ${year}`);

      let yearData = [];

      for (const volume of volumes) {
        const volumeExists = await page.$('select[name="volume"]');
        if (volumeExists) {
          await page.select('select[name="volume"]', volume.value);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          console.warn(`Skipping volume selection as volume dropdown is not available for Year: ${year.text}`);
        }
        let parts = [{ value: "", text: "Full Volume" }];
        if (await page.$("select[name='partno']")) {
          parts = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("select[name='partno'] option"))
              .map(option => ({ value: option.value, text: option.innerText.trim() }))
              .filter(opt => opt.value !== "");
          });
        }

        console.log(`Found ${parts.length} parts for Volume: ${volume.text}`);

        for (const part of parts.length > 0 ? parts : [{ value: null, text: "No Part" }]) {
          if (part.value) {
            try {
              await page.select('select[name="partno"]', part.value);
              await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
              console.warn(`Skipping part selection as partno dropdown is not available for Year: ${year.text}, Volume: ${volume.text}`);
            }
          }

          await page.waitForSelector("li a[onclick]", { timeout: 30000 });

          console.log("Extracting links...");
          const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("li a[onclick]")).map((el) => {
              const onclickValue = el.getAttribute("onclick");
              const match = onclickValue.match(/view_judgment\('([^']+)','([^']+)'\)/);
              //console.log("match:", match);
              if (match) {
                return {
                  link: "https://digiscr.sci.gov.in/view_judgment?id=" + match[1],
                  staus: "pending"
                  //text: el.innerText.trim(),
                };
              }
              return null;
            }).filter(Boolean);
          });

          if (links.length === 0) {
            console.warn(`No links found for Year: ${year.text}, Volume: ${volume.text}, Part: ${part.text}`);
            continue;
          }
          //console.log("links:", links);
          yearData.push({ ...links });
          
        }
      }

      const filePath = path.join(dataDir, `Links_${year}.json`);
      await fs.writeJson(filePath, yearData);
      console.log(`Saved Linksd for Year: ${year}`);
    }
      const jsonFilePath = path.join(dataDir, `Links_${year}.json`);
      console.log("jsonFilePath:", jsonFilePath);
      let jsonData = JSON.parse(fs.readFileSync(jsonFilePath, "utf8"));

      // Launch second browser for scraping details
      scrapingBrowser = await chromium.launch({ headless: true });
      const context = await scrapingBrowser.newContext();
      const scrapingPage = await context.newPage();

      for (let group of jsonData) {
        if (!group || typeof group !== 'object') {
          console.log("Invalid group structure detected");
          continue;
        }

        for (let key in group) {
          let entry = group[key];
          if (!entry) {
            console.log("Entry is undefined for key:", key);
            continue;
          }

          if (entry.staus === "pending") {
            console.log(`Processing: ${entry.link}`);

            try {
              await scrapingPage.goto(entry.link, { waitUntil: "domcontentloaded" });
              await scrapingPage.waitForSelector(".table-responsive");

              const details = await scrapeJudgmentDetails(scrapingPage);

              entry.details = details;
              entry.staus = "done";
              console.log(`Done: ${entry.link}`);
            } catch (error) {
              console.error(`Failed to process ${entry.link}:`, error);
            }
          }
        }
      }

      // Save updated JSON
      fs.writeFileSync(jsonFilePath, JSON.stringify(jsonData, null, 2));
      console.log("JSON file updated successfully!");

      if (scrapingBrowser) {
        await scrapingBrowser.close();
      }
    }

    // Send success response
    res.status(200).json({ message: "Scraping completed successfully" });

  } catch (error) {
    console.error("Operation failed:", error);
    res.status(500).json({ error: `Operation failed: ${error.message}` });
  } finally {
    // Ensure browsers are closed
    if (initialBrowser) {
      await initialBrowser.close();
    }
    if (scrapingBrowser) {
      await scrapingBrowser.close();
    }
  }
}

async function scrapeJudgmentDetails(page) {
  return await page.evaluate(() => {
    const getTableData = (labelText) => {
      const rows = Array.from(document.querySelectorAll(".table-responsive table tbody tr"));
      const row = rows.find(tr => tr.children[0]?.innerText.trim() === labelText);
      return row ? row.children[1]?.innerText.trim() || "N/A" : "N/A";
    };

    const getHeader5Data = (headerText) => {
      const divs = Array.from(document.querySelectorAll(".view-keyword"));
      const div = divs.find(div => div.children[0]?.innerText.trim() === headerText);
      return div ? div.children[1]?.innerText.trim() || "N/A" : "N/A";
    };

    return {
      scr_citation: getTableData("SCR Citation:"),
      year_volume: getTableData("Year/Volume:"),
      date_of_judgment: getTableData("Date of Judgment:"),
      petitioner: getTableData("Petitioner:"),
      disposal_nature: getTableData("Disposal Nature:"),
      neutral_citation: getTableData("Neutral Citation:"),
      judgment_delivered_by: getTableData("Judgment Delivered by:"),
      respondent: getTableData("Respondent:"),
      case_type: getTableData("Case Type:"),
      order_judgment: getTableData("Order/Judgment:"),
      headnote: getHeader5Data("1. Headnote"),
      act: getHeader5Data("3. Act"),
      keyword: getHeader5Data("4. Keyword"),
    };
  });
}


















