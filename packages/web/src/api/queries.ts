/**
 * Query keys and hooks over `endpoints.ts`.
 *
 * Keys are declared once here so an invalidation after upload, analyze or
 * delete cannot miss a cache entry by mistyping a key inline.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as api from "./endpoints.js";

export const queryKeys = {
  demo: ["demo"] as const,
  cases: ["cases"] as const,
  case: (caseId: string) => ["case", caseId] as const,
  caseReport: (caseId: string) => ["case", caseId, "report"] as const,
  narrative: (caseId: string, documentId?: string) =>
    ["case", caseId, "narrative", documentId ?? null] as const,
  document: (documentId: string) => ["document", documentId] as const,
  documentReport: (documentId: string) => ["document", documentId, "report"] as const,
  documentLayout: (documentId: string) => ["document", documentId, "layout"] as const,
  clause: (clauseId: string) => ["clause", clauseId] as const,
};

export function useDemoCatalog() {
  return useQuery({
    queryKey: queryKeys.demo,
    queryFn: ({ signal }) => api.getDemoCatalog({ signal }),
  });
}

export function useCases() {
  return useQuery({
    queryKey: queryKeys.cases,
    queryFn: ({ signal }) => api.listCases({ signal }),
  });
}

export function useCase(caseId: string) {
  return useQuery({
    queryKey: queryKeys.case(caseId),
    queryFn: ({ signal }) => api.getCase(caseId, { signal }),
  });
}

export function useCaseReport(caseId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.caseReport(caseId),
    queryFn: ({ signal }) => api.getCaseReport(caseId, { signal }),
    enabled,
  });
}

export function useDocument(documentId: string) {
  return useQuery({
    queryKey: queryKeys.document(documentId),
    queryFn: ({ signal }) => api.getDocument(documentId, { signal }),
  });
}

/**
 * `staleTime: Infinity` is not a guess: the layout is derived from a
 * content-addressed blob and served `immutable`, so for a given document id
 * these bytes can never change.
 */
export function useDocumentLayout(documentId: string) {
  return useQuery({
    queryKey: queryKeys.documentLayout(documentId),
    queryFn: ({ signal }) => api.getDocumentLayout(documentId, { signal }),
    staleTime: Infinity,
  });
}

export function useClause(clauseId: string | null) {
  return useQuery({
    queryKey: queryKeys.clause(clauseId ?? ""),
    queryFn: ({ signal }) => api.getClause(clauseId ?? "", { signal }),
    enabled: clauseId !== null,
    staleTime: Infinity,
  });
}

export function useAdoptDemo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.adoptDemo(),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.cases }),
  });
}

export function useCreateCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.createCase(title),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.cases }),
  });
}

export function useDeleteCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (caseId: string) => api.deleteCase(caseId),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.cases }),
  });
}

export function useAnalyzeCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (caseId: string) => api.analyzeCase(caseId),
    onSuccess: (_result, caseId) => void client.invalidateQueries({ queryKey: ["case", caseId] }),
  });
}
