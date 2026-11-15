import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import { CompanyConfig, Job } from "./interfaces/index";

const ROOT_DIR = process.cwd();
const COMPANIES_PATH = path.join(ROOT_DIR, "data", "companies.json");
const SEEN_JOBS_PATH = path.join(ROOT_DIR, "data", "seen-jobs.json");
const README_PATH = path.join(ROOT_DIR, "README.md");
const HTML_PATH = path.join(ROOT_DIR, "index.html");

// Target filters (adjust regex to match your tech stack & seniority)
const TITLE_REGEX =
  /(software engineer|frontend|backend|fullstack|developer|junior)/i;
const EXCLUDE_REGEX = /(senior|staff|lead|principal|director|manager)/i;

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
      }));
  } catch (e) {
    console.error(`Error fetching Greenhouse for ${company}:`, e);
    return [];
  }
}

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
      }));
  } catch (e) {
    console.error(`Error fetching Lever for ${company}:`, e);
    return [];
  }
}

async function fetchHtmlJobs(company: string, url: string): Promise<Job[]> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Compatible; JobCrawlerBot/1.0)" },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const jobs: Job[] = [];

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
          : $(el).closest("a").attr("href") || url;
        if (jobUrl && !jobUrl.startsWith("http")) {
          const base = new URL(url);
          jobUrl = `${base.origin}${jobUrl.startsWith("/") ? "" : "/"}${jobUrl}`;
        }

        jobs.push({
          id: `html-${company.toLowerCase()}-${text.replace(/\s+/g, "-")}`,
          company,
          title: text.replace(/\s+/g, " ").trim(),
          url: jobUrl!,
        });
      }
    });

    return jobs;
  } catch (e) {
    console.error(`Error scraping HTML for ${company}:`, e);
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
      if (fileContent) {
        seenJobIds = JSON.parse(fileContent);
      }
    } catch (e) {
      console.warn(
        "Warning: seen-jobs.json was empty or invalid, initializing fresh tracking history.",
      );
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
      allJobs.push(...(await fetchHtmlJobs(c.name, c.url)));
    }
  }

  // Deduplicate jobs by ID
  const uniqueJobs = Array.from(
    new Map(allJobs.map((j) => [j.id, j])).values(),
  );

  // State Tracking & New Badge Detection
  const currentJobIds: string[] = [];
  const processedJobs: Job[] = uniqueJobs.map((job) => {
    currentJobIds.push(job.id);
    const isNew = !seenJobIds.includes(job.id);
    return { ...job, isNew };
  });

  // Save current run IDs back to seen-jobs.json
  fs.writeFileSync(
    SEEN_JOBS_PATH,
    JSON.stringify(currentJobIds, null, 2),
    "utf-8",
  );

  // 1. Build README.md Dashboard
  let md = `# 🎯 Personal Automated Career Portal\n\n`;
  md += `> Live aggregator powered by GitHub Actions, TypeScript, APIs & HTML Scrapers.\n\n`;
  md += `**Last Checked:** \`${new Date().toUTCString()}\`  \n`;
  md += `**Active Positions Found:** \`${processedJobs.length}\`\n\n`;
  md += `---\n\n`;
  md += `| Status | Company | Role / Title | Direct Apply |\n`;
  md += `| :---: | :--- | :--- | :---: |\n`;

  if (processedJobs.length === 0) {
    md += `| — | No matching roles found at this moment. Check back tomorrow! | — | — |\n`;
  } else {
    for (const job of processedJobs) {
      const badge = job.isNew ? "🔥 **NEW**" : "✅ Active";
      md += `| ${badge} | **${job.company}** | ${job.title} | [Apply Here](${job.url}) |\n`;
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
  <style>
    body { font-family: 'Inter', sans-serif; }
  </style>
</head>
<body class="bg-[#f6f6ef] text-[#222222] min-h-screen antialiased">
  
  <!-- YC Orange Top Bar -->
  <div class="bg-[#f16529] h-1.5 w-full"></div>

  <div class="max-w-5xl mx-auto px-4 py-8">
    
    <!-- Header -->
    <header class="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-stone-200 pb-6 mb-6 gap-4">
      <div class="flex items-center gap-3">
        <div class="bg-[#f16529] text-white font-bold px-3 py-2 rounded text-lg tracking-wider shadow-sm">YC</div>
        <div>
          <h1 class="text-2xl font-bold tracking-tight text-stone-900">Startup Job Board</h1>
          <p class="text-stone-500 text-xs mt-0.5">Automated aggregated roles across top startups & tech companies</p>
        </div>
      </div>
      <div class="flex items-center gap-3 text-xs text-stone-600 bg-white border border-stone-200 px-3 py-2 rounded-lg shadow-sm">
        <div>Openings: <span class="font-bold text-stone-900">${processedJobs.length}</span></div>
        <div class="w-px h-3 bg-stone-200"></div>
        <div>Updated: <span class="font-mono text-stone-500">${new Date().toISOString().replace("T", " ").substring(0, 16)} UTC</span></div>
      </div>
    </header>

    <!-- Search Bar (YC Minimalist Style) -->
    <div class="mb-6">
      <div class="relative">
        <span class="absolute inset-y-0 left-0 flex items-center pl-3.5 pointer-events-none text-stone-400">🔍</span>
        <input type="text" id="searchInput" placeholder="Search by company name (e.g. Close, Buffer) or role title..." 
          class="w-full bg-white border border-stone-300 rounded-lg pl-10 pr-4 py-2.5 text-sm text-stone-900 placeholder-stone-400 focus:outline-none focus:border-[#f16529] focus:ring-1 focus:ring-[#f16529] shadow-sm transition-all">
      </div>
    </div>

    <!-- Job Listings Container -->
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
            
            <!-- Left Info -->
            <div class="space-y-1.5 flex-1 min-w-0">
              <div class="flex items-center gap-2.5 flex-wrap">
                <span class="font-semibold text-stone-900 text-base tracking-tight company-name">${job.company}</span>
                ${job.isNew ? '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-orange-50 text-[#f16529] border border-orange-200">NEW</span>' : ""}
              </div>
              <div class="text-sm font-medium text-stone-700 job-title">${job.title}</div>
            </div>

            <!-- Right Action -->
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

    <!-- Footer -->
    <footer class="mt-10 text-center text-xs text-stone-400">
      Automated Startup Job Portal &bull; Inspired by Y Combinator Design Aesthetic
    </footer>

  </div>

  <!-- Realtime Filter Script -->
  <script>
    const searchInput = document.getElementById('searchInput');
    const jobCards = document.querySelectorAll('.job-card');

    searchInput.addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      jobCards.forEach(card => {
        const company = card.querySelector('.company-name').textContent.toLowerCase();
        const title = card.querySelector('.job-title').textContent.toLowerCase();
        if (company.includes(term) || title.includes(term)) {
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
  console.log("Successfully generated YC-styled index.html dashboard.");
}

run();
