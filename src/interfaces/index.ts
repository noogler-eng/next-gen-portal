export interface CompanyConfig {
  name: string;
  type: 'greenhouse' | 'lever' | 'html';
  identifier?: string;
  url?: string;
}

export interface Job {
  id: string;
  company: string;
  title: string;
  url: string;
  isNew?: boolean;
}