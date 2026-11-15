import * as fs from "fs";
import * as path from "path";
import * as cheerio from "cheerio";
import { Job, CompanyConfig } from "./interfaces/index";

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

  // 2. Build Interactive index.html Web Dashboard
  const htmlContent = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Automated Career Portal</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = { darkMode: 'class' }
  </script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen font-sans antialiased selection:bg-indigo-500 selection:text-white">
  <div class="max-w-6xl mx-auto px-4 py-10">
    
    <!-- Header -->
    <header class="flex flex-col md:flex-row md:items-center md:justify-between border-b border-slate-800 pb-6 mb-8 gap-4">
      <div>
        <h1 class="text-3xl font-extrabold tracking-tight text-white flex items-center gap-3">
          <span>🎯</span> Automated Career Portal
        </h1>
        <p class="text-slate-400 text-sm mt-1">Aggregated live from company ATS boards & custom career pages.</p>
      </div>
      <div class="flex items-center gap-4 text-sm text-slate-400 bg-slate-900 border border-slate-800 px-4 py-2 rounded-xl">
        <div>Total Openings: <span class="font-bold text-indigo-400">${processedJobs.length}</span></div>
        <div class="w-px h-4 bg-slate-800"></div>
        <div>Updated: <span class="font-mono text-slate-300">${new Date().toISOString().replace("T", " ").substring(0, 16)} UTC</span></div>
      </div>
    </header>

    <!-- Search Input -->
    <div class="mb-8">
      <input type="text" id="searchInput" placeholder="Search by company name or job title..." 
        class="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors">
    </div>

    <!-- Job Table -->
    <div class="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="border-b border-slate-800 bg-slate-900/50 text-slate-400 text-xs uppercase tracking-wider">
              <th class="py-4 px-6 font-semibold">Status</th>
              <th class="py-4 px-6 font-semibold">Company</th>
              <th class="py-4 px-6 font-semibold">Role Title</th>
              <th class="py-4 px-6 font-semibold text-right">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800 text-sm">
            ${
              processedJobs.length === 0
                ? `
              <tr>
                <td colspan="4" class="py-12 text-center text-slate-500">No matching roles found at this moment. Check back tomorrow!</td>
              </tr>
            `
                : processedJobs
                    .map(
                      (job) => `
              <tr class="hover:bg-slate-800/40 transition-colors job-row">
                <td class="py-4 px-6 whitespace-nowrap">
                  ${job.isNew ? '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20">🔥 NEW</span>' : '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">✅ Active</span>'}
                </td>
                <td class="py-4 px-6 font-semibold text-white whitespace-nowrap company-name">${job.company}</td>
                <td class="py-4 px-6 text-slate-300 job-title">${job.title}</td>
                <td class="py-4 px-6 text-right whitespace-nowrap">
                  <a href="${job.url}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-all shadow-lg shadow-indigo-600/20">
                    Apply &rarr;
                  </a>
                </td>
              </tr>
            `,
                    )
                    .join("")
            }
          </tbody>
        </table>
      </div>
    </div>

    <!-- Footer -->
    <footer class="mt-12 text-center text-xs text-slate-600">
      Automated Career Portal &bull; Powered by TypeScript & GitHub Actions
    </footer>

  </div>

  <!-- Realtime Search Script -->
  <script>
    const searchInput = document.getElementById('searchInput');
    const rows = document.querySelectorAll('.job-row');

    searchInput.addEventListener('input', (e) => {
      const term = e.target.value.toLowerCase();
      rows.forEach(row => {
        const company = row.querySelector('.company-name').textContent.toLowerCase();
        const title = row.querySelector('.job-title').textContent.toLowerCase();
        row.style.display = (company.includes(term) || title.includes(term)) ? '' : 'none';
      });
    });
  </script>
</body>
</html>`;

  fs.writeFileSync(HTML_PATH, htmlContent, "utf-8");
  console.log("Successfully generated index.html dashboard.");
}

run();
