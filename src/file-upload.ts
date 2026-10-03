import {ref, uploadBytesResumable, type FirebaseStorage} from "firebase/storage";

function size(value: number) {
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB`
    : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${Math.ceil(value / 1024)} KiB`;
}

export async function uploadFile(storage: FirebaseStorage, path: string, file: File, form: HTMLFormElement) {
  const progress = form.querySelector<HTMLProgressElement>("#progress")!;
  const status = form.querySelector<HTMLElement>("#upload-status")!;
  const controls = form.querySelector<HTMLElement>("#upload-controls")!;
  const pause = form.querySelector<HTMLButtonElement>("#pause-upload")!;
  const cancel = form.querySelector<HTMLButtonElement>("#cancel-upload")!;
  // Pass the File directly: Firebase slices it into resumable chunks. Never
  // load a disk image into an ArrayBuffer or send it through the callable API.
  const task = uploadBytesResumable(ref(storage, path), file, {contentType: "application/octet-stream", cacheControl: "private, no-store"});
  progress.hidden = false; progress.value = 0; controls.hidden = false;
  pause.disabled = false; cancel.disabled = false;
  const toggle = () => {
    pause.disabled = true;
    const changed = task.snapshot.state === "paused" ? task.resume() : task.pause();
    if (!changed) pause.disabled = false;
  };
  const stop = () => {
    if (confirm("Cancel this upload? To upload this file later, you will need to start again.")) task.cancel();
  };
  pause.addEventListener("click", toggle);
  cancel.addEventListener("click", stop);
  try {
    await new Promise<void>((resolve, reject) => task.on("state_changed", snapshot => {
      const paused = snapshot.state === "paused";
      progress.value = Math.floor(snapshot.bytesTransferred / snapshot.totalBytes * 100);
      const transferred = `${size(snapshot.bytesTransferred)} of ${size(snapshot.totalBytes)}`;
      progress.setAttribute("aria-valuetext", transferred);
      status.textContent = `${paused ? "Paused" : "Uploading"} — ${progress.value}% · ${transferred}`;
      pause.textContent = paused ? "Resume upload" : "Pause upload";
      pause.disabled = false;
    }, reject, resolve));
  } finally {
    controls.hidden = true;
    pause.disabled = true; cancel.disabled = true;
    pause.removeEventListener("click", toggle);
    cancel.removeEventListener("click", stop);
  }
}
