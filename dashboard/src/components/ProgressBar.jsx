export default function ProgressBar({ progress, isOverSLA }) {
  return (
    <div className="w-full bg-settld-border rounded-full h-4 overflow-hidden">
      <div
        className={`h-full transition-all duration-300 ${
          isOverSLA ? "bg-gradient-to-r from-settld-error to-red-400" : "bg-gradient-to-r from-settld-accent to-indigo-400"
        }`}
        style={{ width: `${Math.min(progress, 100)}%` }}
      />
    </div>
  );
}

