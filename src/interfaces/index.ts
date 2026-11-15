export interface CompanyConfig {
  name: string;
  type: "greenhouse" | "lever" | "html" | "yc";
  identifier?: string;
  url?: string;
  maxPages?: number; // Optional pagination limit for HTML scrapers (defaults to 5)
}

export interface Job {
  id: string;
  company: string;
  title: string;
  url: string;
  location?: string;
  jobType?: string;
  isNew?: boolean;
}
