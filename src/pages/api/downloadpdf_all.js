import puppeteer from "puppeteer";
import fs from "fs-extra";
import path from "path";
import axios from "axios";

async function downloadPDF(pdfUrl, savePath) {
  try {
    console.log(`Downloading PDF from: ${pdfUrl} to ${savePath}`);

    const response = await axios({
      url: pdfUrl,
      method: "GET",
      responseType: "stream",
    });

    await fs.ensureDir(path.dirname(savePath));
    const writer = fs.createWriteStream(savePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (error) {
    console.error("Failed to download PDF:", pdfUrl, error.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Only GET requests allowed" });
  }

  try {
    const browser = await puppeteer.launch({ headless: false, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1280, height: 800 });

    console.log("Navigating to site...");
    await page.goto("https://digiscr.sci.gov.in", { waitUntil: "networkidle2" });

    // Get all available years
    await page.waitForSelector("select[name='year']", { timeout: 15000 });
    const years = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("select[name='year'] option"))
        .map(option => option.value)
        .filter(value => value);
    });

    console.log(`Found ${years.length} years to process.`);

    for (const year of years) {
      try {
        if (year === "2025" || year === "2024" || year=== "2023" || year === "2022") {
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

        for (const volume of volumes) {
          try {
            console.log(`Selecting Volume: ${volume.text}`);
            await page.select("select[name='volume']", volume.value);
            await new Promise(resolve => setTimeout(resolve, 3000));

            let parts = [{ value: "", text: "Full Volume" }];
            if (await page.$("select[name='part']")) {
              parts = await page.evaluate(() => {
                return Array.from(document.querySelectorAll("select[name='part'] option"))
                  .map(option => ({ value: option.value, text: option.innerText.trim() }))
                  .filter(opt => opt.value !== "");
              });
            }

            console.log(`Found ${parts.length} parts for Volume: ${volume.text}`);

            for (const part of parts) {
              try {
                console.log(`Selecting Part: ${part.text}`);
                if (part.value) {
                  await page.select("select[name='part']", part.value);
                  await new Promise(resolve => setTimeout(resolve, 3000));
                }

                await page.waitForSelector(".inner-icon a[href*='pdf_viewer_print']", { timeout: 10000 });

                const judgments = await page.evaluate(() => {
                  return Array.from(document.querySelectorAll("li"))
                    .map(li => {
                      const titleElement = li.querySelector("a[onclick^='view_judgment']");
                      const pdfElement = li.querySelector(".inner-icon a[href*='pdf_viewer_print']");

                      if (titleElement && pdfElement) {
                        let pdfUrl = pdfElement.getAttribute("href");
                        if (!pdfUrl.startsWith("http")) {
                          pdfUrl = "https://digiscr.sci.gov.in/" + pdfUrl;
                        }

                        return {
                          text: titleElement.innerText.trim().replace(/[@:/]/g, "_"),
                          pdfUrl: decodeURIComponent(pdfUrl)
                        };
                      }
                      return null;
                    })
                    .filter(Boolean);
                });

                console.log(`Found ${judgments.length} judgments in Year: ${year}, Volume: ${volume.text}, Part: ${part.text}`);

                for (let judgment of judgments) {
                  try {
                    console.log(`Processing: ${judgment.text}`);
                    const savePath = path.join("public", "pdfs", year, `Volume_${volume.text}`, `Part_${part.text}`, `${judgment.text}.pdf`);
                    await downloadPDF(judgment.pdfUrl, savePath);
                    console.log(`Downloaded PDF for ${judgment.text}`);
                  } catch (error) {
                    console.error(`Error downloading PDF for ${judgment.text}`, error);
                  }
                }
              } catch (error) {
                console.error(`Error processing Part: ${part.text} in Volume: ${volume.text}`, error);
              }
            }
          } catch (error) {
            console.error(`Error processing Volume: ${volume.text}`, error);
          }
        }
      } catch (error) {
        console.error(`Error processing Year: ${year}`, error);
      }
    }

    await browser.close();
    res.status(200).json({ message: "Scraping and PDF download completed for all years." });
  } catch (error) {
    res.status(500).json({ error: `Scraping failed: ${error.message}` });
  }
}
