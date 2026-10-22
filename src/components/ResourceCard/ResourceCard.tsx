import Image from "next/image";

interface Resource {
  title: string;
  link: string;
  format: string;
  topic: string;
  language: string;
  embedHtml?: string;
  ogImage?: string;
}

interface ResourceCardProps {
  resource: Resource;
  dappBannerUrl?: string;
}

const getYouTubeId = (url: string): string | null => {
  const match = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  );
  return match ? match[1] : null;
};

const getFormatColor = (format: string) => {
  switch (format) {
    case "Video":
      return "bg-red-500/10 text-red-500";
    case "Article":
      return "bg-blue-500/10 text-blue-500";
    case "Tweet":
      return "bg-sky-500/10 text-sky-500";
    case "Technical documentation":
      return "bg-purple-500/10 text-purple-500";
    default:
      return "bg-gray-500/10 text-gray-500";
  }
};

const ResourceCard = ({ resource, dappBannerUrl }: ResourceCardProps) => {
  const youtubeId = getYouTubeId(resource.link);
  const isVideo = resource.format === "Video" && youtubeId;
  const hasOgImage = !!resource.ogImage;

  return (
    <div className="border border-border-grey dark:border-white/10 rounded-lg overflow-hidden bg-white dark:bg-white/5 hover:shadow-box-image-shadow-hover transition-shadow group">
      {isVideo ? (
        <div className="relative aspect-video">
          <iframe
            src={`https://www.youtube.com/embed/${youtubeId}`}
            title={resource.title}
            className="w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
      ) : hasOgImage ? (
        <a
          href={resource.link}
          target="_blank"
          rel="noopener noreferrer"
          className="block relative aspect-video overflow-hidden"
        >
          <Image
            src={resource.ogImage!}
            alt={resource.title}
            layout="fill"
            unoptimized
            objectFit="cover"
            className="transition-transform duration-300 group-hover:scale-105"
          />
        </a>
      ) : dappBannerUrl ? (
        <a
          href={resource.link}
          target="_blank"
          rel="noopener noreferrer"
          className="block relative aspect-video overflow-hidden"
        >
          <Image
            src={dappBannerUrl}
            alt={resource.title}
            layout="fill"
            objectFit="cover"
            className="transition-transform duration-300 group-hover:scale-105"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex items-end p-3">
            <p className="text-white text-sm font-semibold line-clamp-2 leading-tight">
              {resource.title}
            </p>
          </div>
        </a>
      ) : (
        <a
          href={resource.link}
          target="_blank"
          rel="noopener noreferrer"
          className="block relative aspect-video bg-gradient-to-br from-gray-100 to-gray-200 dark:from-white/5 dark:to-white/10 flex items-center justify-center"
        >
          <div className="text-center px-4">
            <p className="text-sm font-semibold dark:text-white line-clamp-3">
              {resource.title}
            </p>
          </div>
        </a>
      )}
      <div className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium ${getFormatColor(resource.format)}`}
          >
            {resource.format}
          </span>
          {resource.language !== "English" && (
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-600">
              {resource.language}
            </span>
          )}
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-white/10 text-light-charcoal dark:text-lightgrey">
            {resource.topic}
          </span>
        </div>
        <a
          href={resource.link}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
        >
          <h3 className="font-semibold dark:text-white group-hover:text-orange transition-colors line-clamp-2">
            {resource.title}
          </h3>
        </a>
      </div>
    </div>
  );
};

export default ResourceCard;
