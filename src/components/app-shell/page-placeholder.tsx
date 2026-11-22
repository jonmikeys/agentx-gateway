import { Construction } from "lucide-react";
import { allPages } from "@/components/app-shell/nav";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Placeholder body for CRM pages that later stages implement. Content comes from nav.ts. */
export function PagePlaceholder({ href }: { href: string }) {
  const page = allPages.find((candidate) => candidate.href === href);
  if (!page) throw new Error(`No nav entry for ${href}`);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{page.title}</h1>
        <p className="text-muted-foreground">{page.description}</p>
      </div>
      <Card>
        <CardHeader className="items-center text-center">
          <Construction className="size-8 text-muted-foreground" />
          <CardTitle>Nothing here yet</CardTitle>
          <CardDescription>Coming in {page.stage}.</CardDescription>
        </CardHeader>
        <CardContent className="text-center text-sm text-muted-foreground">
          This page is scaffolding. See docs/spec.md for the planned behaviour.
        </CardContent>
      </Card>
    </div>
  );
}
