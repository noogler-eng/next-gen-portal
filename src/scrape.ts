import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";

interface Company {
  name: string;
  url: string;
}

interface JobMatch {
  company: string;
  title: string;
  url: string;
}

async function runScraper() {
  const companiesPath = path.join(process.cwd(), "data", "companies.json");

  if (!fs.existsSync(companiesPath)) {
    console.error("companies.json not found!");
    process.exit(1);
  }

  const companies: Company[] = JSON.parse(
    fs.readFileSync(companiesPath, "utf-8"),
  );
  const matchedJobs: JobMatch[] = [];

  // Regex pattern for roles you are tracking
  const jobRegex =
    /(software engineer|frontend|backend|fullstack|developer|junior)/i;

  for (const company of companies) {
    try {
      console.log(`Checking career page for: ${company.name} (${company.url})`);

      const response = await fetch(company.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Compatible; JobCrawlerBot/1.0; +https://github.com)",
        },
      });

      if (!response.ok) {
        console.warn(
          `Skipping ${company.name}: HTTP status ${response.status}`,
        );
        continue;
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      // Search through links and semantic headings/lists on the page
      $("a, h2, h3, li").each((_, element) => {
        const text = $(element).text().trim();

        if (jobRegex.test(text) && text.length > 5 && text.length < 120) {
          let jobUrl = $(element).is("a")
            ? $(element).attr("href")
            : company.url;

          // Resolve relative URLs
          if (jobUrl && !jobUrl.startsWith("http")) {
            const baseUrl = new URL(company.url);
            jobUrl = `${baseUrl.origin}${jobUrl.startsWith("/") ? "" : "/"}${jobUrl}`;
          }

          matchedJobs.push({
            company: company.name,
            title: text,
            url: jobUrl || company.url,
          });
        }
      });
    } catch (error) {
      console.error(`Error scraping ${company.name}:`, error);
    }
  }

  // Deduplicate entries by title & company
  const uniqueJobs = Array.from(
    new Map(
      matchedJobs.map((job) => [`${job.company}-${job.title}`, job]),
    ).values(),
  );

  // Generate the updated Markdown content for your GitHub Home page
  let markdown = `# 🚀 Automated Career Portal\n\n`;
  markdown += `*Scraped automatically via GitHub Actions & TypeScript.*\n\n`;
  markdown += `**Last Updated:** ${new Date().toISOString().replace("T", " ").substring(0, 19)} UTC\n\n`;
  markdown += `| Company | Role / Title | Direct Link |\n`;
  markdown += `| :--- | :--- | :--- |\n`;

  if (uniqueJobs.length === 0) {
    markdown += `| No matching roles found during the latest check. | - | - |\n`;
  } else {
    for (const job of uniqueJobs) {
      markdown += `| **${job.company}** | ${job.title} | [Apply Here](${job.url}) |\n`;
    }
  }

  const readmePath = path.join(process.cwd(), "README.md");
  fs.writeFileSync(readmePath, markdown, "utf-8");
  console.log(
    `Successfully updated README.md with ${uniqueJobs.length} matches.`,
  );
}

runScraper();
