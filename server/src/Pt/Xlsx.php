<?php

declare(strict_types=1);

namespace ChrisManager\Pt;

use ChrisManager\HttpException;

/**
 * Minimal .xlsx reader: values of the first worksheet as a grid. Numbers come back as int/float (dates and
 * times stay Excel serial numbers), text as strings. Enough for trip-log uploads without PhpSpreadsheet
 * (which needs the gd extension).
 */
final class Xlsx
{
    /** @return list<list<mixed>> */
    public static function firstSheet(string $path): array
    {
        $zip = new \ZipArchive();
        if ($zip->open($path) !== true) {
            throw new HttpException(422, 'That .xlsx file could not be opened');
        }
        try {
            $sheetPath = self::firstSheetPath($zip);
            $strings = self::sharedStrings($zip);
            $xml = $zip->getFromName($sheetPath);
            if ($xml === false) {
                throw new HttpException(422, 'The workbook has no worksheet');
            }
        } finally {
            $zip->close();
        }

        $reader = new \XMLReader();
        $reader->XML($xml, null, LIBXML_NONET | LIBXML_COMPACT);
        $rows = [];
        $row = null;
        $col = 0;
        $type = '';
        $value = null;
        $inValue = false;
        while ($reader->read()) {
            if ($reader->nodeType === \XMLReader::ELEMENT) {
                switch ($reader->localName) {
                    case 'row':
                        $row = [];
                        $col = 0;
                        if ($reader->isEmptyElement) {
                            $rows[] = [];
                            $row = null;
                        }
                        break;
                    case 'c':
                        $ref = (string) $reader->getAttribute('r');
                        $col = $ref !== '' ? self::columnIndex($ref) : $col + 1;
                        $type = (string) $reader->getAttribute('t');
                        $value = null;
                        break;
                    case 'v':
                    case 't': // inline string text
                        $inValue = !$reader->isEmptyElement;
                        if (!$inValue) {
                            $value = ($value ?? '') . '';
                        }
                        break;
                }
            } elseif ($inValue && ($reader->nodeType === \XMLReader::TEXT || $reader->nodeType === \XMLReader::CDATA
                || $reader->nodeType === \XMLReader::SIGNIFICANT_WHITESPACE)) {
                $value = ($value ?? '') . $reader->value;
            } elseif ($reader->nodeType === \XMLReader::END_ELEMENT) {
                switch ($reader->localName) {
                    case 'v':
                    case 't':
                        $inValue = false;
                        break;
                    case 'c':
                        if ($row !== null && $value !== null) {
                            $row[$col] = match ($type) {
                                's'       => $strings[(int) $value] ?? '',
                                'b'       => $value === '1',
                                'str', 'inlineStr', 'e' => $value,
                                default   => is_numeric($value) ? $value + 0 : $value,
                            };
                        }
                        break;
                    case 'row':
                        if ($row !== null) {
                            $grid = [];
                            $max = $row ? max(array_keys($row)) : -1;
                            for ($i = 0; $i <= $max; $i++) {
                                $grid[] = $row[$i] ?? null;
                            }
                            $rows[] = $grid;
                            $row = null;
                        }
                        break;
                }
            }
        }
        $reader->close();
        return $rows;
    }

    /** "C12" → 2 (zero-based). */
    private static function columnIndex(string $ref): int
    {
        $n = 0;
        foreach (str_split(preg_replace('/\d+/', '', strtoupper($ref))) as $ch) {
            $n = $n * 26 + (ord($ch) - 64);
        }
        return $n - 1;
    }

    private static function firstSheetPath(\ZipArchive $zip): string
    {
        $wb = $zip->getFromName('xl/workbook.xml');
        $rels = $zip->getFromName('xl/_rels/workbook.xml.rels');
        if ($wb !== false && $rels !== false) {
            $wbXml = simplexml_load_string($wb, options: LIBXML_NONET);
            $relXml = simplexml_load_string($rels, options: LIBXML_NONET);
            $sheet = $wbXml?->sheets?->sheet[0] ?? null;
            if ($sheet !== null && $relXml !== false) {
                $rid = (string) $sheet->attributes('http://schemas.openxmlformats.org/officeDocument/2006/relationships')['id'];
                foreach ($relXml->Relationship as $rel) {
                    if ((string) $rel['Id'] === $rid) {
                        $target = ltrim((string) $rel['Target'], '/');
                        return str_starts_with($target, 'xl/') ? $target : 'xl/' . $target;
                    }
                }
            }
        }
        return 'xl/worksheets/sheet1.xml';
    }

    /** @return list<string> */
    private static function sharedStrings(\ZipArchive $zip): array
    {
        $xml = $zip->getFromName('xl/sharedStrings.xml');
        if ($xml === false) {
            return [];
        }
        $doc = simplexml_load_string($xml, options: LIBXML_NONET);
        $out = [];
        foreach ($doc->si ?? [] as $si) {
            if (isset($si->t)) {
                $out[] = (string) $si->t;
            } else {
                $text = '';
                foreach ($si->r as $run) { // rich text: several runs
                    $text .= (string) $run->t;
                }
                $out[] = $text;
            }
        }
        return $out;
    }
}
