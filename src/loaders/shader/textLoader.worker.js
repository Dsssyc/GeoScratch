self.addEventListener('message', (event) => {

  const {url, workerIndex } = event.data;
  loadText(url, workerIndex);
});
  
function loadText(url) {

  fetch(url)
    .then(response => response.text())
    .then(text => {

      self.postMessage({ text });
    })
    .catch(error => console.error('Error loading shader codes:', error));
}
  