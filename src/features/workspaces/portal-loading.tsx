import "./portal-loading.css";

/**
 * The loading placeholder of the portal: the same plain status sentence as before (it is what a screen reader hears and what the
 * tests look for), with a quiet skeleton under it so the page does not jump when the screen arrives. The skeleton is decoration
 * only (aria-hidden) and does not move for people who ask their system for reduced motion.
 */
export function PortalLoading({
  label = "Loading this screen…",
}: {
  label?: string;
}) {
  return (
    <div className="portal-loading" aria-busy="true">
      <p role="status">{label}</p>
      <div className="portal-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
