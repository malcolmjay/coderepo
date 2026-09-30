"use strict";

document.querySelectorAll("form[data-confirm]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
});

const uploadForm = document.getElementById("upload-form");
const csrf = () => document.querySelector("[name=csrfmiddlewaretoken]")?.value;
async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    redirect: "error",
    headers: { "X-CSRFToken": csrf() },
    body,
  });
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Your session may have expired. Sign in again and retry.");
  }
  const result = await response.json();
  if (!response.ok) {
    const errors = Object.entries(result.errors || {}).map(
      ([field, items]) =>
        `${field}: ${items.map((item) => item.message).join(" ")}`,
    );
    throw new Error(
      result.error ||
        errors.join(" · ") ||
        "The request could not be completed.",
    );
  }
  return result;
}

if (uploadForm) {
  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = document.getElementById("upload-status");
    const progress = document.getElementById("upload-progress");
    const button = uploadForm.querySelector("button[type=submit]");
    const file = document.getElementById("release-file").files[0];
    if (!file) return;
    status.classList.remove("error");
    button.disabled = true;
    try {
      if (file.size > 5 * 1024 ** 3 || file.size === 0)
        throw new Error("Choose a non-empty file no larger than 5 GiB.");
      status.textContent = "Preparing your upload…";
      const metadata = new FormData(uploadForm);
      metadata.set("filename", file.name);
      metadata.set("size_bytes", file.size.toString());
      const ticket = await post(uploadForm.action, metadata);
      const payload = new FormData();
      Object.entries(ticket.upload.fields).forEach(([key, value]) =>
        payload.append(key, value),
      );
      payload.append("file", file); // S3 requires the file field last.
      progress.hidden = false;
      progress.value = 0;
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", ticket.upload.url);
        xhr.timeout = 90 * 60 * 1000;
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            progress.value = Math.round((e.loaded / e.total) * 100);
            status.textContent = `Uploading… ${progress.value}% — keep this page open.`;
          }
        });
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(
                new Error(
                  "Storage rejected the upload. Check the bucket CORS, credentials, and file size, then retry.",
                ),
              );
        xhr.onerror = () =>
          reject(
            new Error("Upload interrupted. Check your connection and retry."),
          );
        xhr.ontimeout = () =>
          reject(new Error("Upload timed out. Please retry."));
        xhr.send(payload);
      });
      status.textContent = "Verifying the file…";
      await post(`${uploadForm.dataset.finishBase}${ticket.id}/finish/`);
      window.location.assign(uploadForm.dataset.finishBase);
    } catch (error) {
      status.textContent = `${error.message} If the file reached storage, use Retry verification in the release list.`;
      status.classList.add("error");
      button.disabled = false;
    }
  });
}

document.querySelectorAll(".verify-upload").forEach((button) => {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await post(button.dataset.url);
      window.location.reload();
    } catch (error) {
      window.alert(error.message);
      button.disabled = false;
    }
  });
});
