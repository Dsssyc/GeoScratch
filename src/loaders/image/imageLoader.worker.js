self.addEventListener('message', (event) => {

  const {url, workerIndex } = event.data;
  loadImage(url, workerIndex);
});
  
function loadImage(url) {
  
    fetch(url)
      .then(response => response.blob())
      .then(blob => createImageBitmap(blob, {imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "default"}))
      .then(imageBitmap => {

      self.postMessage({ imageBitmap });
    })
    .catch(error => console.error(`Error loading image (url: ${url})`, error));
}
  