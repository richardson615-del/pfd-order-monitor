"use client";

import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export default function PushSetup() {
  const [status, setStatus] = useState<"idle" | "enabling" | "on" | "error">(
    "idle"
  );

  async function enable() {
    setStatus("enabling");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("Push notifications aren't supported in this browser.");
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Permission denied.");

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!
        ),
      });

      const supabase = supabaseBrowser();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify(sub),
      });

      setStatus("on");
    } catch (err) {
      console.error(err);
      setStatus("error");
    }
  }

  if (status === "on") {
    return <span className="success-text">Notifications on</span>;
  }

  return (
    <button className="btn small" onClick={enable} disabled={status === "enabling"}>
      {status === "enabling" ? "Enabling..." : "Enable notifications"}
    </button>
  );
}
