// Login form of the online version.
const form = document.querySelector("#login-form");
const error = document.querySelector("#login-error");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: document.querySelector("#password").value }),
    });
    if (res.ok) {
      location.reload();
      return;
    }
    const body = await res.json().catch(() => null);
    error.textContent = body?.error ?? `Fout ${res.status}`;
  } catch {
    error.textContent = "Geen verbinding met de server.";
  }
  error.hidden = false;
  button.disabled = false;
});
