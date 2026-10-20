import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Keep in sync with the `@utility text-*` roles in globals.css. */
const TYPOGRAPHY_ROLES = [
  "body",
  "body-bold",
  "body-medium",
  "body-strong",
  "caption",
  "display",
  "display-lg",
  "eyebrow",
  "heading",
  "label",
  "micro",
  "title",
  "title-medium",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TYPOGRAPHY_ROLES] }],
    },
  },
});

const GENERIC_PATTERNS: RegExp[] = [
  /^(gmail|googlemail|yahoo|hotmail|outlook|live|msn|aol|protonmail|zoho|yandex|mail)\./i,
  /(mail|email|mx|webmail)\.[a-z]{2,}$/i,
  /^mail\d*\./i,
];

const KNOWN_GENERIC_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "protonmail.com",
  "zoho.com",
  "yandex.com",
  "mail.com",
  "icloud.com",
  "me.com",
];

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const getProjectColor = (projectName: string) => {
  // Categorical identity palette (carries identity, not status). Defined as
  // semantic tokens in globals.css so it stays theme-aware and single-sourced.
  const colors = [
    "bg-categorical-1",
    "bg-categorical-2",
    "bg-categorical-3",
    "bg-categorical-4",
    "bg-categorical-5",
    "bg-categorical-6",
    "bg-categorical-7",
    "bg-categorical-8",
    "bg-categorical-9",
    "bg-categorical-10",
  ];

  const hash = projectName
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);

  return colors[hash % colors.length];
};

export const isGenericDomain = (domain: string): boolean => {
  if (!domain) {
    return false;
  }

  const lowerDomain = domain.toLowerCase();

  if (KNOWN_GENERIC_DOMAINS.includes(lowerDomain)) {
    return true;
  }

  return GENERIC_PATTERNS.some((pattern) => pattern.test(domain));
};

export const extractDomain = (email: string) => {
  const parts = email.split("@");
  if (parts.length !== 2) {
    throw new Error("Invalid email address");
  }
  return parts[1].toLowerCase();
};

export const getNameInitials = (name: string | null | undefined) => {
  if (!name || name.trim() === "") {
    return "AN";
  }

  const nameParts = name.split(" ").filter((part) => part.trim().length > 0);

  if (nameParts.length === 0) {
    return "?";
  }

  if (nameParts.length === 1) {
    return nameParts[0].charAt(0).toUpperCase();
  }

  const firstInitial = nameParts[0].charAt(0);
  const lastInitial = nameParts.at(-1)?.charAt(0) || "";
  return (firstInitial + lastInitial).toUpperCase();
};

export function sanitizeContent(raw: string) {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const normalizeRepoName = (repoName: string): string => {
  if (!repoName) {
    return "";
  }

  const cleanName = repoName.replace(/https:\/\/github\.com\//g, "");

  const parts = cleanName.split("/").filter((part) => part.trim() !== "");
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }

  return cleanName;
};

export const MONGO_ID_REGEX = /^[0-9a-fA-F]{24}$/;
export const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i;
export const VALID_ID_REGEX =
  /^[0-9a-fA-F]{24}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/i;
