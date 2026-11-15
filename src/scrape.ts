import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import { CompanyConfig, Job } from "./interfaces";

const ROOT_DIR = process.cwd();
const COMPANIES_PATH = path.join(ROOT_DIR, "data", "companies.json");
const SEEN_JOBS_PATH = path.join(ROOT_DIR, "data", "seen-jobs.json");
const README_PATH = path.join(ROOT_DIR, "README.md");
const HTML_PATH = path.join(ROOT_DIR, "index.html");

// Target filters (adjust regex to match your tech stack & seniority)
const TITLE_REGEX =
  /(software engineer|frontend|backend|fullstack|developer|junior|forward|deployed)/i;
const EXCLUDE_REGEX = /(senior|staff|lead|principal|director|manager)/i;

// Helper: Resolve relative URLs
function resolveUrl(baseUrl: string, relativeUrl: string): string {
  if (relativeUrl.startsWith("http")) return relativeUrl;
  try {
    const base = new URL(baseUrl);
    return `${base.origin}${relativeUrl.startsWith("/") ? "" : "/"}${relativeUrl}`;
  } catch {
    return baseUrl;
  }
}

// 1. Greenhouse API Scraper
async function fetchGreenhouseJobs(
  company: string,
  identifier: string,
): Promise<Job[]> {
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${identifier}/jobs`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { jobs: any[] };

    return data.jobs
      .filter(
        (j: any) => TITLE_REGEX.test(j.title) && !EXCLUDE_REGEX.test(j.title),
      )
      .map((j: any) => ({
        id: `gh-${identifier}-${j.id}`,
        company,
        title: j.title,
        url: j.absolute_url,
        location: j.location?.name || "Remote / Unspecified",
        jobType: "Full-time",
      }));
  } catch (e) {
    console.error(`Error fetching Greenhouse for ${company}:`, e);
    return [];
  }
}

// 2. Lever API Scraper
async function fetchLeverJobs(
  company: string,
  identifier: string,
): Promise<Job[]> {
  try {
    const res = await fetch(
      `https://api.lever.co/v0/postings/${identifier}?mode=json`,
    );
    if (!res.ok) return [];
    const postings = (await res.json()) as any[];

    return postings
      .filter(
        (p: any) => TITLE_REGEX.test(p.text) && !EXCLUDE_REGEX.test(p.text),
      )
      .map((p: any) => ({
        id: `lever-${identifier}-${p.id}`,
        company,
        title: p.text,
        url: p.hostedUrl,
        location: p.categories?.location || "Remote / Unspecified",
        jobType: p.categories?.commitment || "Full-time",
      }));
  } catch (e) {
    console.error(`Error fetching Lever for ${company}:`, e);
    return [];
  }
}

// 3. Paginated HTML Scraper
async function fetchHtmlJobs(
  company: string,
  startUrl: string,
  maxPages = 5,
): Promise<Job[]> {
  const jobs: Job[] = [];
  const visitedPages = new Set<string>();
  const seenJobUrls = new Set<string>();
  let currentUrl: string | null = startUrl;
  let pageCount = 0;

  while (currentUrl && pageCount < maxPages && !visitedPages.has(currentUrl)) {
    visitedPages.add(currentUrl);
    pageCount++;

    try {
      console.log(`  -> Scraping ${company} page ${pageCount}: ${currentUrl}`);
      const res = await fetch(currentUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Compatible; JobCrawlerBot/1.0)",
        },
      });
      if (!res.ok) break;

      const html = await res.text();
      const $ = cheerio.load(html);
      let newJobsOnThisPage = 0;

      $("a, h2, h3, li").each((_, el) => {
        const text = $(el).text().trim();
        if (
          TITLE_REGEX.test(text) &&
          !EXCLUDE_REGEX.test(text) &&
          text.length > 5 &&
          text.length < 100
        ) {
          let jobUrl = $(el).is("a")
            ? $(el).attr("href")
            : $(el).closest("a").attr("href") || currentUrl!;
          jobUrl = resolveUrl(currentUrl!, jobUrl!);

          if (!seenJobUrls.has(jobUrl)) {
            seenJobUrls.add(jobUrl);
            const cleanTitle = text.replace(/\s+/g, " ").trim();

            // Try to sniff location from surrounding DOM text
            const contextText = $(el).parent().text();
            let location = "Remote / Flexible";
            if (/remote/i.test(contextText)) location = "Remote";
            else if (/india/i.test(contextText)) location = "India / Remote";

            jobs.push({
              id: `html-${company.toLowerCase()}-${cleanTitle.replace(/\s+/g, "-")}`,
              company,
              title: cleanTitle,
              url: jobUrl,
              location,
              jobType: "Full-time",
            });
            newJobsOnThisPage++;
          }
        }
      });

      if (newJobsOnThisPage === 0 && pageCount > 1) break;

      // Detect Next Page link
      let nextUrl: string | null = null;
      const nextLink = $(
        'a[rel="next"], a.next, a.next-page, a[aria-label*="Next" i]',
      ).first();
      if (nextLink.length > 0 && nextLink.attr("href")) {
        nextUrl = resolveUrl(currentUrl, nextLink.attr("href")!);
      } else {
        $("a").each((_, el) => {
          const linkText = $(el).text().trim().toLowerCase();
          if (
            (linkText === "next" ||
              linkText === "next ›" ||
              linkText === "next →") &&
            $(el).attr("href")
          ) {
            nextUrl = resolveUrl(currentUrl!, $(el).attr("href")!);
            return false;
          }
        });
      }

      // Fallback query parameter pagination (?page=N)
      if (!nextUrl) {
        const parsed = new URL(startUrl);
        parsed.searchParams.set("page", String(pageCount + 1));
        const candidateUrl = parsed.toString();
        if (!visitedPages.has(candidateUrl)) nextUrl = candidateUrl;
      }

      currentUrl = nextUrl;
      if (currentUrl && pageCount < maxPages) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (e) {
      console.error(`Error scraping HTML page ${pageCount} for ${company}:`, e);
      break;
    }
  }

  return jobs;
}

// 4. Y Combinator Work at a Startup Scraper (`type: "yc"`)
async function fetchYcJobs(company: string, url: string): Promise<Job[]> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const jobs: Job[] = [];

    $("a, div, li").each((_, el) => {
      const text = $(el).text().trim();
      if (
        TITLE_REGEX.test(text) &&
        !EXCLUDE_REGEX.test(text) &&
        text.length > 5 &&
        text.length < 120
      ) {
        const linkEl = $(el).is("a") ? $(el) : $(el).find("a").first();
        const jobUrl = linkEl.attr("href")
          ? resolveUrl(url, linkEl.attr("href")!)
          : url;

        const parentText = $(el).parent().text();
        let location = "Remote / Worldwide";
        if (/remote/i.test(parentText)) location = "Remote";
        else if (/india/i.test(parentText)) location = "India / Remote";

        const cleanTitle = text.split("\n")[0].trim();
        if (cleanTitle.length > 5 && cleanTitle.length < 100) {
          jobs.push({
            id: `yc-${company.toLowerCase()}-${cleanTitle.replace(/\s+/g, "-")}`,
            company,
            title: cleanTitle,
            url: jobUrl,
            location,
            jobType: "Full-time",
          });
        }
      }
    });

    return Array.from(new Map(jobs.map((j) => [j.title, j])).values());
  } catch (e) {
    console.error(`Error fetching YC jobs for ${company}:`, e);
    return [];
  }
}

async function run() {
  if (!fs.existsSync(COMPANIES_PATH)) {
    console.error("companies.json missing!");
    process.exit(1);
  }

  const companies: CompanyConfig[] = JSON.parse(
    fs.readFileSync(COMPANIES_PATH, "utf-8"),
  );

  // Safely load previously seen job IDs
  let seenJobIds: string[] = [];
  if (fs.existsSync(SEEN_JOBS_PATH)) {
    try {
      const fileContent = fs.readFileSync(SEEN_JOBS_PATH, "utf-8").trim();
      if (fileContent) seenJobIds = JSON.parse(fileContent);
    } catch {
      seenJobIds = [];
    }
  }

  let allJobs: Job[] = [];

  for (const c of companies) {
    console.log(`Checking ${c.name} (${c.type})...`);
    if (c.type === "greenhouse" && c.identifier) {
      allJobs.push(...(await fetchGreenhouseJobs(c.name, c.identifier)));
    } else if (c.type === "lever" && c.identifier) {
      allJobs.push(...(await fetchLeverJobs(c.name, c.identifier)));
    } else if (c.type === "html" && c.url) {
      allJobs.push(...(await fetchHtmlJobs(c.name, c.url, c.maxPages ?? 5)));
    } else if (c.type === "yc" && c.url) {
      allJobs.push(...(await fetchYcJobs(c.name, c.url)));
    }
  }

  const uniqueJobs = Array.from(
    new Map(allJobs.map((j) => [j.id, j])).values(),
  );

  const currentJobIds: string[] = [];
  const processedJobs: Job[] = uniqueJobs.map((job) => {
    currentJobIds.push(job.id);
    const isNew = !seenJobIds.includes(job.id);
    return { ...job, isNew };
  });

  fs.writeFileSync(
    SEEN_JOBS_PATH,
    JSON.stringify(currentJobIds, null, 2),
    "utf-8",
  );

  // 1. Build README.md Dashboard
  let md = `# 🎯 Personal Automated Career Portal\n\n`;
  md += `> Live aggregator powered by GitHub Actions, TypeScript, ATS APIs, YC & Paginated Scrapers.\n\n`;
  md += `**Last Checked:** \`${new Date().toUTCString()}\`  \n`;
  md += `**Active Positions Found:** \`${processedJobs.length}\`\n\n`;
  md += `---\n\n`;
  md += `| Status | Company | Role / Title | Location | Type | Direct Apply |\n`;
  md += `| :---: | :--- | :--- | :--- | :---: | :---: |\n`;

  if (processedJobs.length === 0) {
    md += `| — | No matching roles found at this moment. Check back tomorrow! | — | — | — | — |\n`;
  } else {
    for (const job of processedJobs) {
      const badge = job.isNew ? "🔥 **NEW**" : "✅ Active";
      md += `| ${badge} | **${job.company}** | ${job.title} | ${job.location} | ${job.jobType} | [Apply](${job.url}) |\n`;
    }
  }

  md += `\n\n---  \n*Maintained automatically via automated background workflows.*`;
  fs.writeFileSync(README_PATH, md, "utf-8");
  console.log(
    `README updated successfully with ${processedJobs.length} roles.`,
  );

  // 2. Build Y Combinator ("Work at a Startup") Styled index.html Dashboard
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Startup Job Board | YC-Style Career Portal</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style> body { font-family: 'Inter', sans-serif; } </style>
</head>
<body class="bg-[#f6f6ef] text-[#222222] min-h-screen antialiased">
  
  <div class="bg-[#f16529] h-1.5 w-full"></div>

  <div class="max-w-6xl mx-auto px-4 py-8">
    
    <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-stone-200 pb-6 mb-6 gap-4">
      <div class="flex items-center gap-3">
        <div class="bg-[#f16529] text-white font-bold px-3 py-2 rounded text-lg tracking-wider shadow-sm">YC</div>
        <div>
          <h1 class="text-2xl font-bold tracking-tight text-stone-900">Startup Job Board</h1>
          <p class="text-stone-500 text-xs mt-0.5">Aggregated roles across top startups, YC companies & tech firms</p>
        </div>
      </div>
      <div class="flex items-center gap-3 text-xs text-stone-600 bg-white border border-stone-200 px-3 py-2 rounded-lg shadow-sm">
        <div>Openings: <span class="font-bold text-stone-900">${processedJobs.length}</span></div>
        <div class="w-px h-3 bg-stone-200"></div>
        <div>Updated: <span class="font-mono text-stone-500">${new Date().toISOString().replace("T", " ").substring(0, 16)} UTC</span></div>
      </div>
    </header>

    <div class="mb-6">
      <div class="relative">
        <span class="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none text-stone-400">🔍</span>
        <input type="text" id="searchInput" placeholder="Search by company name, role title, or location..." 
          class="w-full bg-white border border-stone-300 rounded-lg pl-10 pr-4 py-2.5 text-sm text-stone-900 placeholder-stone-400 focus:outline-none focus:border-[#f16529] focus:ring-1 focus:ring-[#f16529] shadow-sm transition-all">
      </div>
    </div>

    <div class="bg-white border border-stone-200 rounded-xl overflow-hidden shadow-sm">
      <div class="divide-y divide-stone-100" id="jobList">
        ${
          processedJobs.length === 0
            ? `
          <div class="py-16 text-center text-stone-400 text-sm">
            No matching openings found at this moment. Check back tomorrow!
          </div>
        `
            : processedJobs
                .map(
                  (job) => `
          <div class="p-4 sm:p-5 hover:bg-stone-50/80 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4 job-card">
            
            <div class="space-y-1.5 flex-1 min-w-0">
              <div class="flex items-center gap-2.5 flex-wrap">
                <span class="font-semibold text-stone-900 text-base tracking-tight company-name">${job.company}</span>
                ${job.isNew ? '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-orange-50 text-[#f16529] border border-orange-200">NEW</span>' : ""}
              </div>
              <div class="text-sm font-medium text-stone-700 job-title">${job.title}</div>
              <div class="flex items-center gap-3 text-xs text-stone-500">
                <span class="bg-stone-100 px-2 py-0.5 rounded text-stone-600 font-medium location-text">📍 ${job.location}</span>
                <span class="bg-stone-100 px-2 py-0.5 rounded text-stone-600 font-medium">${job.jobType}</span>
              </div>
            </div>

            <div class="flex items-center gap-3 self-end sm:self-center shrink-0">
              <a href="${job.url}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center justify-center px-4 py-2 rounded-lg text-xs font-semibold bg-[#f16529] hover:bg-[#e0561d] text-white transition-colors shadow-sm">
                Apply &rarr;
              </a>
            </div>

          </div>
        `,
                )
                .join("")
        }
      </div>
    </div>

    <footer class="mt-10 text-center text-xs text-stone-400">
      Automated Startup Job Portal &bull; Y Combinator Aesthetic & Pagination Enabled
    </footer>

  </div>

  <script>
    const searchInput = document.getElementById('searchInput');
    const jobCards = document.querySelectorAll('.job-card');

    searchInput.addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      jobCards.forEach(card => {
        const company = card.querySelector('.company-name').textContent.toLowerCase();
        const title = card.querySelector('.job-title').textContent.toLowerCase();
        const location = card.querySelector('.location-text').textContent.toLowerCase();
        if (company.includes(term) || title.includes(term) || location.includes(term)) {
          card.style.display = '';
        } else {
          card.style.display = 'none';
        }
      });
    });
  </script>
</body>
</html>`;

  fs.writeFileSync(HTML_PATH, htmlContent, "utf-8");
  console.log(
    "Successfully generated YC-styled index.html with location and pagination support.",
  );
}

run();
