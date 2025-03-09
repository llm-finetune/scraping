import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import https from 'https';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Only GET requests are allowed' });
  }

  const BASE_URL = "https://www.indiacode.nic.in";
  const START_URL = `https://www.indiacode.nic.in/handle/123456789/1362/browse?type=actyear`;

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    console.log("Opening start page...");

    console.log("🚀 Launching browser...");
    const browser = await puppeteer.launch({ headless: false });
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/91.0.4472.124 Safari/537.36"
    );

    
    await page.goto(START_URL, { waitUntil: "networkidle2" });

     // Increase timeout to handle slow loading
    await page.waitForSelector('.list-group', { timeout: 10000 });
    let allYears = [];
    // Extract year-wise links
    const years = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.list-group-item > a')).map(link => ({
        year: link.textContent.trim(),
        url: link.href.startsWith('/') ? `https://www.indiacode.nic.in${link.getAttribute('href')}` : link.href
      }));
    });

    // 🔄 Handle Pagination - Extract all year links
    while (true) {
      await page.waitForSelector('.list-group-item > a', { timeout: 10000 });

      const years = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.list-group-item > a')).map(link => ({
          year: link.textContent.trim(),
          url: link.href.startsWith('/') ? `https://www.indiacode.nic.in${link.getAttribute('href')}` : link.href
        }));
      });

      allYears.push(...years);
      console.log(`📌 Extracted ${years.length} years. Total so far: ${allYears.length}`);

      // Check for next page button
      const nextPage = await page.$('.panel-footer .pull-right');
      if (!nextPage) {
        console.log("✅ No more pages. Scraping complete.");
        break;
      }

      // Click next page and wait for load
      await Promise.all([
        page.click('.panel-footer .pull-right'),
        page.waitForNavigation({ waitUntil: 'networkidle2' })
      ]);
    }

    let yearData = [];

    // 🔄 Scrape Acts for Each Year
    for (let { year, url } of allYears) {
      console.log(`Fetching acts for year: ${year}`);
      console.log(`🔗 Navigating to ${url}...`);
      const browser = await puppeteer.launch({ headless: false });
     const yearPage = await browser.newPage();

    await yearPage.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/91.0.4472.124 Safari/537.36"
    );
      //const yearPage = await browser.newPage();
      await yearPage.goto(url, { waitUntil: 'networkidle2' });
      await yearPage.waitForSelector('.panel', { timeout: 5000 });
      const actsExist = await yearPage.$('.panel');

      const tableExists = await yearPage.$('.panel.table.table-bordered');

      if (!tableExists) {
        console.warn(`No table found for ${year}. Skipping...`);
        await yearPage.close();
        continue;
      }

      const acts = await yearPage.evaluate(() => {
        return Array.from(document.querySelectorAll('.panel.table.table-bordered tr'))
          .slice(1) // Skip header row
          .map(row => {
            const cols = row.querySelectorAll('td');
            return {
              enactment_date: cols[0]?.textContent.trim() || null,
              act_number: cols[1]?.textContent.trim() || null,
              short_title: cols[2]?.textContent.trim() || null,
              view_link: cols[3]?.querySelector('a') 
                ? `https://www.indiacode.nic.in${cols[3].querySelector('a').getAttribute('href')}`
                : null
            };
          })
          .filter(act => act.view_link);
      });

      // Visit each act’s "View" link to get PDFs
      for (let act of acts) {
        if (!act.view_link) continue;

        const actPage = await browser.newPage();
        await actPage.goto(act.view_link, { waitUntil: 'networkidle2' });

        const pdfLinks = await actPage.evaluate(() => {
          return Array.from(document.querySelectorAll('a[href*="/bitstream/"]')).map(link => ({
            title: link.textContent.trim(),
            url: link.href.startsWith('/') ? `https://www.indiacode.nic.in${link.getAttribute('href')}` : link.href
          }));
        });

        act.pdfs = pdfLinks;
        console.log(`📄 Found ${pdfLinks.length} PDFs for ${act.short_title}`);

        // 🔄 Download PDFs
        for (let pdf of pdfLinks) {
          const fileName = pdf.url.split('/').pop();
          const filePath = path.join(process.cwd(), 'public', 'indiacode', fileName);
          await downloadPDF(pdf.url, filePath);
          pdf.local_path = `/indiacode/${fileName}`;
        }

        await actPage.close();
      }

      console.log(`✅ Extracted ${acts.length} acts for ${year}`);
      yearData.push({ year, acts });
      await new Promise(resolve => setTimeout(resolve, 2000));
      await browser.close();
    }

    console.log("Scraping completed!");
    await new Promise(resolve => setTimeout(resolve, 2000));
    await browser.close();

    res.status(200).json(yearData);
  } catch (error) {
    console.error("Scraping Error:", error.message);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await browser.close();
    res.status(500).json({ error: error.message });
  }
}

// 📂 Download PDF function
async function downloadPDF(url, filePath) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(filePath);
    https.get(url, (response) => {
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`📥 Downloaded: ${filePath}`);
        resolve();
      });
    }).on('error', (error) => {
      fs.unlink(filePath, () => {}); // Delete file on error
      console.error(`⚠️ PDF Download Error: ${error.message}`);
      reject(error);
    });
  });
}
