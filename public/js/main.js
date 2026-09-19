// JBM School ERP — Main JS

// Mobile sidebar (hamburger) toggle
(function () {
  const btn = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!btn || !sidebar || !backdrop) return;

  function closeSidebar() { sidebar.classList.remove('open'); backdrop.classList.remove('open'); }
  function openSidebar() { sidebar.classList.add('open'); backdrop.classList.add('open'); }

  btn.addEventListener('click', () => {
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
  });
  backdrop.addEventListener('click', closeSidebar);
  sidebar.querySelectorAll('.sidebar-item').forEach(item => item.addEventListener('click', closeSidebar));
})();

// Dropdown toggle
document.querySelectorAll('.dropdown').forEach(dd => {
  dd.addEventListener('click', e => { e.stopPropagation(); dd.classList.toggle('open'); });
});
document.addEventListener('click', () => {
  document.querySelectorAll('.dropdown.open').forEach(dd => dd.classList.remove('open'));
});

// Auto-dismiss alerts
setTimeout(() => {
  document.querySelectorAll('.alert').forEach(a => {
    a.style.transition='opacity 0.5s'; a.style.opacity='0';
    setTimeout(() => a.remove(), 500);
  });
}, 4000);

// Tab switching — used across all admin pages
function showTab(tabId, clickedBtn) {
  const parent = clickedBtn ? clickedBtn.closest('.tab-bar, .tabs, [data-tabs]') : null;
  const scope = parent ? parent.parentElement : document;
  scope.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  if (parent) parent.querySelectorAll('.tab-item, .tab').forEach(t => t.classList.remove('active'));
  else document.querySelectorAll('.tab-item, .tab').forEach(t => t.classList.remove('active'));
  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');
  if (clickedBtn) clickedBtn.classList.add('active');
}

// Make tab-item links work (onclick="showTab('id',this)")
document.querySelectorAll('.tab-item[data-tab], .tab[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab, btn));
});
