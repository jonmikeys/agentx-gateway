"use client";

import { useState } from "react";
import { toast } from "sonner";
import { TagsInput } from "@/components/crm/tags-input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { adminFetch, errorMessage } from "@/lib/admin-client";
import type { FlowDetail } from "@/lib/agents/types";

interface SettingsPanelProps {
  flow: FlowDetail;
  routes: string[];
  /** Media tags present in the catalogue, offered as suggestions. */
  mediaTags: string[];
  cameras: { id: string; name: string; enabled: boolean }[];
  onSaved: (flow: FlowDetail) => void;
}

/** Agent settings tab: identity, route, and the media/camera restrictions for client tools. */
export function SettingsPanel({ flow, routes, mediaTags, cameras, onSaved }: SettingsPanelProps) {
  const [name, setName] = useState(flow.name);
  const [slug, setSlug] = useState(flow.slug);
  const [description, setDescription] = useState(flow.description);
  const [enabled, setEnabled] = useState(flow.enabled);
  const [defaultRoute, setDefaultRoute] = useState(flow.settings.default_route_slug ?? "none");
  const [allowedTags, setAllowedTags] = useState(flow.settings.allowed_media_tags ?? []);
  const [allowedCameras, setAllowedCameras] = useState(flow.settings.allowed_cameras ?? []);
  const [saving, setSaving] = useState(false);
  const slugFixed = flow.published_version !== null;

  async function save() {
    setSaving(true);
    try {
      const updated = await adminFetch<FlowDetail>(`flows/${flow.id}`, {
        method: "PATCH",
        body: {
          name,
          description,
          enabled,
          ...(slugFixed ? {} : { slug }),
          settings: {
            default_route_slug: defaultRoute === "none" ? null : defaultRoute,
            allowed_media_tags: allowedTags,
            allowed_cameras: allowedCameras,
          },
        },
      });
      toast.success("Agent settings saved");
      onSaved(updated);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-5 p-4">
      <div className="grid gap-2">
        <Label htmlFor="agent-name">Name</Label>
        <Input id="agent-name" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-slug">Slug</Label>
        <Input
          id="agent-slug"
          className="font-mono text-xs"
          value={slug}
          disabled={slugFixed}
          onChange={(event) => setSlug(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {slugFixed
            ? "Fixed once the chatflow is published so clients keep resolving it."
            : "Lowercase letters, digits, dots, dashes and underscores."}
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-description">Description</Label>
        <Textarea
          id="agent-description"
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="flex items-center justify-between gap-4 rounded-md border p-3">
        <div>
          <Label htmlFor="agent-enabled">Enabled</Label>
          <p className="text-xs text-muted-foreground">
            Disabled agents disappear from the agent picker and requests get invalid_agent.
          </p>
        </div>
        <Switch id="agent-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-route">Default model route</Label>
        <Select value={defaultRoute} onValueChange={setDefaultRoute}>
          <SelectTrigger id="agent-route" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Use the gateway default route</SelectItem>
            {routes.map((route) => (
              <SelectItem key={route} value={route}>
                {route}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Used by LLM nodes set to inherit, and recorded on the session.
        </p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-media-tags">Allowed media tags</Label>
        <TagsInput
          id="agent-media-tags"
          aria-label="Allowed media tags"
          value={allowedTags}
          onChange={setAllowedTags}
          suggestions={mediaTags}
        />
        <p className="text-xs text-muted-foreground">
          Narrows the media offered to client tools and the Client Action picker. Leave empty to
          allow every media item.
        </p>
      </div>
      <div className="grid gap-2">
        <Label>Allowed cameras</Label>
        {cameras.length === 0 ? (
          <p className="text-xs text-muted-foreground">No cameras registered yet.</p>
        ) : (
          <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
            {cameras.map((camera) => (
              <div key={camera.id} className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={`agent-camera-${camera.id}`}
                  aria-label={`Allow camera ${camera.name}`}
                  checked={allowedCameras.includes(camera.id)}
                  disabled={!camera.enabled}
                  onCheckedChange={(checked) =>
                    setAllowedCameras((current) =>
                      checked ? [...current, camera.id] : current.filter((id) => id !== camera.id),
                    )
                  }
                />
                <span className="truncate">{camera.name}</span>
                {!camera.enabled && <span className="text-muted-foreground">(disabled)</span>}
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Leave empty to allow every camera. Otherwise the model and the Client Action picker only
          see these cameras.
        </p>
      </div>
      <Button onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save settings"}
      </Button>
    </div>
  );
}
