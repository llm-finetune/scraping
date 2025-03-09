import puppeteer from "puppeteer";
import fs from "fs-extra";
import path from "path";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Only GET requests allowed" });
  }

  try {
    const browser = await puppeteer.launch({
      headless: false, // Change to true for production
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
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
        if (year !== "2025") {
            continue;
        }
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
                  base64_id: match[1],
                  param2: match[2],
                  text: el.innerText.trim(),
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
          
          for (let link of links) {
            try {
              //console.log(`Opening case: ${link.text}`);
          
              // Click the judgment link and wait for modal
              const element = await page.$(`a[onclick*="'${link.base64_id}',"]`);
              if (element) {
                await element.click();
                await new Promise(resolve => setTimeout(resolve, 2000)); // Allow extra time for modal to load
          
                         
                //console.log(`Successfully opened case: ${link.text}`);
          
                // Extract judgment details
                // Extract judgment details
                  const details = await page.evaluate(() => {
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
                      //case_referred: getHeader5Data("2. Case referred"),
                      act: getHeader5Data("3. Act"),
                      keyword: getHeader5Data("4. Keyword"),
                    };
                  });

                  //console.log(` Extracted Data:`, details);
                  yearData.push({ ...link, details });

                   
                  // Close modal before moving to the next case
                  await page.evaluate(() => {
                  if (typeof goback_filter() === "function") {
                      goback_filter();
                    }
                  });
                  await new Promise(resolve => setTimeout(resolve, 2000));
              } else {
                console.warn(`Element not found for ID: ${link.base64_id}`);
                continue;
              }
          
            } catch (error) {
              console.error(`Error processing case: ${link.text}`, error);
            }
          }
          
        }
      }

      const filePath = path.join(dataDir, `${year}.json`);
      await fs.writeJson(filePath, yearData);
      console.log(`Saved data for Year: ${year}`);
    }

    await browser.close();
    res.status(200).json({ message: "Scraping successful" });
  } catch (error) {
    res.status(500).json({ error: `Scraping failed: ${error.message}` });
  }
}
