import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { parseEdition, type Edition } from "@shared/edition";

/** The server's edition from /api/health (public, no key). Unknown -> null. */
export function useEdition(): Edition | null {
  const { data } = useQuery<Edition | null>({
    queryKey: ["/api/health", "edition"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/health").catch(() => null);
      if (!r) return null;
      const j = await r.json().catch(() => null);
      return parseEdition(j?.edition);
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
  return data ?? null;
}

/** true on the public demo (simulated sample data). */
export function useIsDemo(): boolean {
  return useEdition() === "demo";
}
