"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  type RowSelectionState,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/crm/page-header";
import { SessionStatusBadge } from "@/components/sessions/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminFetch, errorMessage, formatTimestamp } from "@/lib/admin-client";
import { shortId } from "@/lib/format";
import type { SessionListResponse, SessionSummary } from "@/lib/session-types";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;
const ALL = "__all__";

interface Filters {
  q: string;
  status: string;
  route: string;
  apiKeyId: string;
  from: string;
  to: string;
  includeStandalone: boolean;
}

const initialFilters: Filters = {
  q: "",
  status: ALL,
  route: ALL,
  apiKeyId: ALL,
  from: "",
  to: "",
  includeStandalone: false,
};

function filterParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.status !== ALL) params.set("status", filters.status);
  if (filters.route !== ALL) params.set("route", filters.route);
  if (filters.apiKeyId !== ALL) params.set("api_key_id", filters.apiKeyId);
  if (filters.from) params.set("from", `${filters.from}T00:00:00.000Z`);
  if (filters.to) params.set("to", `${filters.to}T23:59:59.999Z`);
  if (filters.includeStandalone) params.set("include_standalone", "true");
  return params;
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function SessionsView({
  apiKeys,
  routes,
}: {
  apiKeys: { id: string; label: string }[];
  routes: string[];
}) {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([{ id: "started_at", desc: true }]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [result, setResult] = useState<SessionListResponse | undefined>();
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const requestCounter = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(filters.q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filters.q]);

  const effectiveFilters = useMemo(
    () => ({ ...filters, q: debouncedQuery }),
    [filters, debouncedQuery],
  );

  const load = useCallback(async () => {
    const ticket = ++requestCounter.current;
    const params = filterParams(effectiveFilters);
    params.set("page", String(page));
    params.set("page_size", String(PAGE_SIZE));
    const sort = sorting[0];
    params.set("sort", sort?.id ?? "started_at");
    params.set("dir", sort?.desc === false ? "asc" : "desc");
    try {
      const response = await adminFetch<SessionListResponse>(`sessions?${params}`);
      if (ticket === requestCounter.current) setResult(response);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      if (ticket === requestCounter.current) setLoading(false);
    }
  }, [effectiveFilters, page, sorting]);

  useEffect(() => {
    void load();
  }, [load]);

  function updateFilters(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
    setRowSelection({});
  }

  const columns = useMemo<ColumnDef<SessionSummary, unknown>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        header: ({ table }) => (
          <Checkbox
            aria-label="Select all sessions on this page"
            checked={table.getIsAllPageRowsSelected()}
            onCheckedChange={(value) => table.toggleAllPageRowsSelected(value === true)}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={`Select session ${shortId(row.original.id)}`}
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(value === true)}
          />
        ),
      },
      {
        id: "started_at",
        header: "Started",
        cell: ({ row }) => (
          <Link
            href={`/sessions/${row.original.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {formatTimestamp(row.original.started_at)}
          </Link>
        ),
      },
      {
        id: "last_activity_at",
        header: "Last activity",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {formatTimestamp(row.original.last_activity_at)}
          </span>
        ),
      },
      {
        id: "client_key",
        header: "Client key",
        enableSorting: false,
        cell: ({ row }) => row.original.api_key_label ?? "Deleted key",
      },
      {
        id: "route",
        header: "Route / agent",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="text-sm">
            <div>{row.original.route_slug ?? "n/a"}</div>
            <div className="text-xs text-muted-foreground">
              {row.original.agent_id ?? "No agent"}
            </div>
          </div>
        ),
      },
      {
        id: "turn_count",
        header: "Turns",
        cell: ({ row }) => row.original.turn_count,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            <SessionStatusBadge status={row.original.status} />
            {row.original.standalone && <Badge variant="outline">Standalone</Badge>}
          </div>
        ),
      },
    ],
    [],
  );

  const table = useReactTable({
    data: result?.data ?? [],
    columns,
    state: { sorting, rowSelection },
    getRowId: (row) => row.id,
    manualSorting: true,
    manualPagination: true,
    enableSortingRemoval: false,
    onSortingChange: (updater) => {
      setSorting(updater);
      setPage(1);
    },
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
  });

  const selectedIds = Object.keys(rowSelection).filter((id) => rowSelection[id]);
  const total = result?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const firstShown = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(page * PAGE_SIZE, total);

  function exportHref(format: "csv" | "json"): string {
    const params =
      selectedIds.length > 0
        ? new URLSearchParams({ ids: selectedIds.join(",") })
        : filterParams(effectiveFilters);
    params.set("format", format);
    return `/api/admin/sessions/export?${params}`;
  }

  async function deleteSelected() {
    try {
      const response = await adminFetch<{ deleted: number }>("sessions/bulk-delete", {
        method: "POST",
        body: { ids: selectedIds },
      });
      toast.success(
        `Deleted ${response.deleted} ${response.deleted === 1 ? "session" : "sessions"}`,
      );
      setRowSelection({});
      setConfirmDelete(false);
      await load();
    } catch (error) {
      toast.error(errorMessage(error));
      setConfirmDelete(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sessions"
        description="Browse conversation sessions and read full transcripts."
        action={
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <Download />
                  {selectedIds.length > 0
                    ? `Export ${selectedIds.length} selected`
                    : "Export results"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a href={exportHref("csv")} download>
                    CSV (one row per session)
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={exportHref("json")} download>
                    JSON (with transcripts)
                  </a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="destructive"
              disabled={selectedIds.length === 0}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 />
              Delete{selectedIds.length > 0 ? ` ${selectedIds.length}` : ""}
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="session-search" className="text-xs text-muted-foreground">
            Search transcripts
          </Label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
            <Input
              id="session-search"
              type="search"
              placeholder="Search messages..."
              className="w-64 pl-8"
              value={filters.q}
              onChange={(event) => updateFilters({ q: event.target.value })}
            />
          </div>
        </div>
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={(status) => updateFilters({ status })}
          allLabel="Any status"
          options={[
            { value: "active", label: "Active" },
            { value: "expired", label: "Expired" },
            { value: "ended", label: "Ended" },
          ]}
        />
        <FilterSelect
          label="Client key"
          value={filters.apiKeyId}
          onChange={(apiKeyId) => updateFilters({ apiKeyId })}
          allLabel="Any key"
          options={apiKeys.map((key) => ({ value: key.id, label: key.label }))}
        />
        <FilterSelect
          label="Route"
          value={filters.route}
          onChange={(route) => updateFilters({ route })}
          allLabel="Any route"
          options={routes.map((slug) => ({ value: slug, label: slug }))}
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor="session-from" className="text-xs text-muted-foreground">
            From
          </Label>
          <Input
            id="session-from"
            type="date"
            className="w-40"
            value={filters.from}
            onChange={(event) => updateFilters({ from: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="session-to" className="text-xs text-muted-foreground">
            To
          </Label>
          <Input
            id="session-to"
            type="date"
            className="w-40"
            value={filters.to}
            onChange={(event) => updateFilters({ to: event.target.value })}
          />
        </div>
        <div className="flex h-8 items-center gap-2">
          <Checkbox
            id="include-standalone"
            checked={filters.includeStandalone}
            onCheckedChange={(value) => updateFilters({ includeStandalone: value === true })}
          />
          <Label htmlFor="include-standalone">Include standalone</Label>
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead key={header.id}>
                      {header.column.getCanSort() ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 font-medium"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === "asc" && <ArrowUp className="size-3" />}
                          {sorted === "desc" && <ArrowDown className="size-3" />}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {loading
                    ? "Loading sessions..."
                    : "No sessions match. Conversations appear here as soon as a client uses the chat API."}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() ? "selected" : undefined}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span data-testid="sessions-range">
          {total === 0 ? "No sessions" : `Showing ${firstShown}-${lastShown} of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((current) => current - 1)}
          >
            <ChevronLeft />
            Previous
          </Button>
          <span>
            Page {page} of {lastPage}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= lastPage}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
            <ChevronRight />
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedIds.length} {selectedIds.length === 1 ? "session" : "sessions"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the selected sessions, their transcripts and their linked
              request logs. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={deleteSelected}>
              Delete permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
