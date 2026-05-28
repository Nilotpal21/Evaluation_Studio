interface Feature {
  name: string;
  legacy: boolean;
  v2: boolean;
  notes?: string;
}

interface FeatureMatrixProps {
  features: Feature[];
}

export function FeatureMatrix({ features }: FeatureMatrixProps) {
  return (
    <div className="my-6 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b-2 border-slate-200">
            <th className="px-4 py-3 text-left font-semibold text-slate-700">Feature</th>
            <th className="px-4 py-3 text-center font-semibold text-slate-700">Legacy Platform</th>
            <th className="px-4 py-3 text-center font-semibold text-slate-700">v2 Platform</th>
            <th className="px-4 py-3 text-left font-semibold text-slate-700">Notes</th>
          </tr>
        </thead>
        <tbody>
          {features.map((feature) => (
            <tr key={feature.name} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-4 py-3 font-medium text-slate-800">{feature.name}</td>
              <td className="px-4 py-3 text-center">
                {feature.legacy ? (
                  <span className="text-green-600 font-bold">{'\u2713'}</span>
                ) : (
                  <span className="text-red-500 font-bold">{'\u2717'}</span>
                )}
              </td>
              <td className="px-4 py-3 text-center">
                {feature.v2 ? (
                  <span className="text-green-600 font-bold">{'\u2713'}</span>
                ) : (
                  <span className="text-red-500 font-bold">{'\u2717'}</span>
                )}
              </td>
              <td className="px-4 py-3 text-slate-600">{feature.notes || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
