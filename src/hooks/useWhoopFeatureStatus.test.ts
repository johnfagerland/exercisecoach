import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWhoopFeatureStatus } from "./useWhoopFeatureStatus";

const mockGetWhoopFeatureStatus = vi.fn();

vi.mock("convex/react", () => ({
  useAction: () => mockGetWhoopFeatureStatus,
}));

vi.mock("../../convex/_generated/api", () => ({
  api: {
    whoop: {
      connections: {
        getWhoopFeatureStatus: "whoop:connections:getWhoopFeatureStatus",
      },
    },
  },
}));

describe("useWhoopFeatureStatus", () => {
  beforeEach(() => {
    mockGetWhoopFeatureStatus.mockReset();
  });

  it("exposes loading and success states", async () => {
    mockGetWhoopFeatureStatus.mockResolvedValueOnce({ enabled: true, hasConnection: false });

    const { result } = renderHook(() => useWhoopFeatureStatus());

    expect(result.current.state).toEqual({ status: "loading" });
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "success",
        data: { enabled: true, hasConnection: false },
      });
    });
  });

  it("exposes action failures and retries immediately", async () => {
    mockGetWhoopFeatureStatus
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ enabled: false, hasConnection: true });

    const { result } = renderHook(() => useWhoopFeatureStatus());

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "error" });
    });

    act(() => result.current.refetch());

    expect(result.current.state).toEqual({ status: "loading" });
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "success",
        data: { enabled: false, hasConnection: true },
      });
    });
    expect(mockGetWhoopFeatureStatus).toHaveBeenCalledTimes(2);
  });
});
