// JBM School ERP — Main JS
document.querySelectorAll('.dropdown').forEach(dd => {
  dd.addEventListener('click', e => { e.stopPropagation(); dd.classList.toggle('open'); });
});
document.addEventListener('click', () => {
  document.querySelectorAll('.dropdown.open').forEach(dd => dd.classList.remove('open'));
});
setTimeout(() => {
  document.querySelectorAll('.alert').forEach(a => {
    a.style.transition='opacity 0.5s'; a.style.opacity='0';
    setTimeout(() => a.remove(), 500);
  });
}, 4000);
