import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhoopConnectionCard } from "./WhoopConnectionCard";

const mockStartOAuth = vi.fn();
const mockRefreshWhoopData = vi.fn();
const mockDisconnectWhoop = vi.fn();
let mockStatus: unknown;

vi.mock("convex/react", () => ({
  useQuery: () => mockStatus,
  useAction: (ref: string) => {
    if (ref === "whoop:oauthFlow:startWhoopOAuth") return mockStartOAuth;
    if (ref === "whoop:sync:refreshWhoopData") return mockRefreshWhoopData;
    if (ref === "whoop:sync:disconnectMyWhoop") return mockDisconnectWhoop;
    throw new Error(`Unexpected action ${ref}`);
  },
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    whoop: {
      connections: {
        getMyWhoopStatus: "whoop:connections:getMyWhoopStatus",
      },
      oauthFlow: {
        startWhoopOAuth: "whoop:oauthFlow:startWhoopOAuth",
      },
      sync: {
        disconnectMyWhoop: "whoop:sync:disconnectMyWhoop",
        refreshWhoopData: "whoop:sync:refreshWhoopData",
      },
    },
  },
}));

describe("WhoopConnectionCard", () => {
  beforeEach(() => {
    mockStartOAuth.mockReset();
    mockRefreshWhoopData.mockReset();
    mockDisconnectWhoop.mockReset();
    mockStatus = {
      state: "active",
      connectedAt: Date.UTC(2026, 6, 20),
      lastSyncedAt: Date.UTC(2026, 6, 21, 18, 30),
      scopes: ["read:recovery", "read:sleep", "read:cycles", "read:profile", "offline"],
    };
  });

  it("renders connected details with readable scope labels", () => {
    render(<WhoopConnectionCard configured />);

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Whoop")).toBeInTheDocument();
    expect(screen.getByText("Recovery")).toBeInTheDocument();
    expect(screen.getByText("Sleep")).toBeInTheDocument();
    expect(screen.getByText("Strain & cycles")).toBeInTheDocument();
    expect(screen.getByText("Profile")).toBeInTheDocument();
    expect(screen.getByText("Connected Jul 20, 2026")).toBeInTheDocument();
    expect(screen.getByText("Last synced Jul 21, 2026, 6:30 PM")).toBeInTheDocument();
    expect(screen.queryByText("read:recovery")).not.toBeInTheDocument();
    expect(screen.queryByText("offline")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync now/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();
  });

  it("uses a compact loading state while status is unresolved", () => {
    mockStatus = undefined;

    render(<WhoopConnectionCard configured />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading Whoop status…");
  });

  it("renders a disconnected state with a readable reason and one-way sync copy", () => {
    mockStatus = {
      state: "disconnected",
      connectedAt: Date.UTC(2026, 6, 20),
      disconnectedAt: Date.UTC(2026, 6, 22),
      reason: "permission_revoked",
      scopes: [],
    };

    render(<WhoopConnectionCard configured />);

    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(screen.getByText(/Permission revoked/)).toBeInTheDocument();
    expect(screen.getByText(/Data flows one way from Whoop/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect whoop/i })).toBeEnabled();
  });

  it("surfaces the last sync error while connected", () => {
    mockStatus = {
      state: "active",
      connectedAt: Date.UTC(2026, 6, 20),
      lastSyncedAt: Date.UTC(2026, 6, 21, 18, 30),
      lastSyncError: "Whoop sync failed with HTTP 500.",
      scopes: ["read:recovery", "offline"],
    };

    render(<WhoopConnectionCard configured />);

    expect(screen.getByText("Last sync failed: Whoop sync failed with HTTP 500.")).toBeVisible();
  });

  it("reports imported recovery, sleep, and cycle counts after a sync", async () => {
    mockRefreshWhoopData.mockResolvedValueOnce({
      success: true,
      recoveries: 3,
      sleeps: 2,
      cycles: 1,
    });

    render(<WhoopConnectionCard configured />);

    fireEvent.click(screen.getByRole("button", { name: /sync now/i }));

    expect(
      await screen.findByText("Whoop synced 3 recoveries, 2 sleeps, and 1 cycle."),
    ).toBeInTheDocument();
    expect(mockRefreshWhoopData).toHaveBeenCalledWith({});
  });

  it("disables every control while disconnecting and reports cleanup with revocation warnings", async () => {
    let resolveDisconnect!: (result: { success: true; warning: string }) => void;
    mockDisconnectWhoop.mockReturnValueOnce(
      new Promise<{ success: true; warning: string }>((resolve) => {
        resolveDisconnect = resolve;
      }),
    );

    render(<WhoopConnectionCard configured />);

    fireEvent.click(screen.getByRole("button", { name: /^disconnect$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /disconnecting/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /sync now/i })).toBeDisabled();
    });

    await act(async () => {
      resolveDisconnect({
        success: true,
        warning: "Whoop token revocation failed; local Whoop data was disconnected.",
      });
    });

    expect(await screen.findByText(/Local imported Whoop data is being removed/i)).toBeVisible();
    expect(screen.getByText(/Whoop token revocation failed/i)).toBeVisible();
  });

  it("discloses Whoop data use and waits for explicit confirmation before starting OAuth", async () => {
    mockStatus = { state: "none" };
    mockStartOAuth.mockResolvedValueOnce({
      success: false,
      error: "Whoop integration is not available on this deployment.",
    });

    render(<WhoopConnectionCard configured />);

    fireEvent.click(screen.getByRole("button", { name: /connect whoop/i }));

    const dialog = screen.getByRole("dialog", { name: /connect whoop to roni/i });
    expect(mockStartOAuth).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent(/read-only access to the recovery, sleep, and strain/i);
    expect(dialog).toHaveTextContent(/your Whoop membership/i);
    expect(dialog).toHaveTextContent(/up to 30 days/i);
    expect(dialog).toHaveTextContent(/Roni and its Gemini coach/i);
    expect(dialog).toHaveTextContent(/Convex, Vercel, and Google AI/i);
    expect(dialog).toHaveTextContent(/not sold or used for advertising/i);
    expect(dialog).toHaveTextContent(/never writes to Whoop/i);
    expect(dialog).toHaveTextContent(/grant only a subset of access/i);
    expect(dialog).toHaveTextContent(/Disconnecting asks Whoop to revoke access/i);
    expect(dialog).toHaveTextContent(/Deleting your Roni account removes stored Whoop/i);
    expect(within(dialog).getByRole("link", { name: /privacy policy/i })).toHaveAttribute(
      "href",
      "/privacy",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: /continue to whoop/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Whoop integration is not available on this deployment.");
    expect(mockStartOAuth).toHaveBeenCalledTimes(1);
    expect(mockStartOAuth).toHaveBeenCalledWith({});
    expect(screen.getByRole("button", { name: /connect whoop/i })).toBeEnabled();
  });

  it("keeps the consent dialog open and disables its actions while OAuth is starting", async () => {
    mockStatus = { state: "none" };
    let resolveStart!: (result: { success: false; error: string }) => void;
    mockStartOAuth.mockReturnValueOnce(
      new Promise<{ success: false; error: string }>((resolve) => {
        resolveStart = resolve;
      }),
    );

    render(<WhoopConnectionCard configured />);

    fireEvent.click(screen.getByRole("button", { name: /connect whoop/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /continue to whoop/i }));

    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: /opening whoop/i })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: /cancel/i })).toBeDisabled();
    });

    await act(async () => {
      resolveStart({ success: false, error: "Connection could not start." });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Connection could not start.");
  });

  it("keeps Disconnect available but disables Sync when configuration is unavailable", () => {
    render(<WhoopConnectionCard configured={false} />);

    expect(screen.getByRole("button", { name: /sync now/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();
    expect(screen.getByText(/Whoop sync is unavailable/i)).toBeVisible();
  });

  it("disables Connect when configuration is unavailable", () => {
    mockStatus = { state: "none" };

    render(<WhoopConnectionCard configured={false} />);

    expect(screen.getByRole("button", { name: /connect whoop/i })).toBeDisabled();
    expect(screen.getByText(/Whoop connection is unavailable/i)).toBeVisible();
    expect(mockStartOAuth).not.toHaveBeenCalled();
  });

  it("surfaces thrown sync failures without leaving controls locked", async () => {
    mockRefreshWhoopData.mockRejectedValueOnce(new Error("Whoop service unavailable."));

    render(<WhoopConnectionCard configured />);

    fireEvent.click(screen.getByRole("button", { name: /sync now/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Whoop service unavailable.");
    expect(screen.getByRole("button", { name: /sync now/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeEnabled();
  });
});
