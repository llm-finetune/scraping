'use client';
import { useState, useEffect } from "react";

export default function Home() {
  const [years, setYears] = useState<string[]>([]);
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [volumes, setVolumes] = useState([]);

  useEffect(() => {
    try{
      
    fetch("/api/scrape") // Auto-trigger scraping on load
      
      .then((res) => res.json())
      .then(() => loadYears());
      
    }
    catch (error) {
      console.error('Error :', error);
    }
  }, []);

  async function loadYears() {
    const res = await fetch("/api/scrape");
    const data = await res.json();
    setYears(Object.keys(data.data));
  }

  async function loadVolumes(year: string) {
    setSelectedYear(year);
    const res = await fetch(`/data/${year}.json`);
    const json = await res.json();
    setVolumes(json.volumes);
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Scraped Reports</h1>
      <div className="mt-4 flex space-x-4">
        <ul className="border p-4 w-1/3">
          {years.map((year) => (
            <li key={year}>
              <button
                className="text-blue-600 hover:underline"
                onClick={() => loadVolumes(year)}
              >
                {year}
              </button>
            </li>
          ))}
        </ul>
        <div className="border p-4 w-2/3">
          {selectedYear && (
            <>
              <h2 className="text-xl font-semibold">{selectedYear}</h2>
              <ul>
                {volumes.map((vol, idx) => (
                  <li key={idx}>{vol}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}