import {
  Bot,
  Cable,
  Camera,
  Image as ImageIcon,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  MessagesSquare,
  Route,
  Server,
  Settings,
} from "lucide-react";

export interface NavPage {
  title: string;
  href: string;
  icon: LucideIcon;
  description: string;
  /** Delivery stage that fills this page in, shown in the placeholder empty state. */
  stage: string;
}

export interface NavGroup {
  id: string;
  title: string;
  pages: NavPage[];
}

/** Single source of truth for the sidebar, breadcrumbs and the command palette. */
export const navGroups: NavGroup[] = [
  {
    id: "overview",
    title: "Overview",
    pages: [
      {
        title: "Dashboard",
        href: "/",
        icon: LayoutDashboard,
        description: "Active sessions, usage, failovers and provider health at a glance.",
        stage: "G3",
      },
    ],
  },
  {
    id: "conversations",
    title: "Conversations",
    pages: [
      {
        title: "Sessions",
        href: "/sessions",
        icon: MessagesSquare,
        description: "Browse conversation sessions and read full transcripts.",
        stage: "G3",
      },
    ],
  },
  {
    id: "agents",
    title: "Agents",
    pages: [
      {
        title: "Chatflows",
        href: "/chatflows",
        icon: Bot,
        description: "Design agents and subflows in the visual chatflow editor.",
        stage: "G7a",
      },
    ],
  },
  {
    id: "media-content",
    title: "Media Content",
    pages: [
      {
        title: "Media",
        href: "/media",
        icon: ImageIcon,
        description: "Images and videos the avatar may show.",
        stage: "G5",
      },
      {
        title: "Cameras",
        href: "/cameras",
        icon: Camera,
        description: "Camera streams the avatar may show.",
        stage: "G5",
      },
    ],
  },
  {
    id: "models-integrations",
    title: "Models & Integrations",
    pages: [
      {
        title: "Providers",
        href: "/providers",
        icon: Server,
        description: "Upstream LLM provider endpoints, keys and health.",
        stage: "G2",
      },
      {
        title: "Model Routes",
        href: "/routes",
        icon: Route,
        description: "Route model names to ordered provider steps with failover.",
        stage: "G2",
      },
      {
        title: "MCP Servers",
        href: "/mcp",
        icon: Cable,
        description: "External MCP servers and the tools the avatar may call.",
        stage: "G6",
      },
    ],
  },
  {
    id: "administration",
    title: "Administration",
    pages: [
      {
        title: "API Keys",
        href: "/api-keys",
        icon: KeyRound,
        description: "Issue, label and revoke client API keys.",
        stage: "G2",
      },
      {
        title: "Settings",
        href: "/settings",
        icon: Settings,
        description: "Session idle timeout, retention and other defaults.",
        stage: "G3",
      },
    ],
  },
];

export const allPages: NavPage[] = navGroups.flatMap((group) => group.pages);

export interface PageLocation {
  group: NavGroup;
  page: NavPage;
}

/** Finds the nav entry for a pathname (exact match, or nested path under a page). */
export function findPageLocation(pathname: string): PageLocation | undefined {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const group of navGroups) {
    for (const page of group.pages) {
      const isMatch =
        page.href === "/"
          ? normalized === "/"
          : normalized === page.href || normalized.startsWith(`${page.href}/`);
      if (isMatch) return { group, page };
    }
  }
  return undefined;
}
